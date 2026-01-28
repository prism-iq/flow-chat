mod transpiler;

use axum::{
    Router,
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    http::StatusCode,
    response::{Html, IntoResponse, Json},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::net::TcpListener;
use tower_http::services::ServeDir;

const PHI: f64 = 1.618_033_988_749_895;
const VERSION: &str = "2.0.0";

static COMPILATIONS: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
    version: &'static str,
    phi: f64,
    compilations: u64,
}

#[derive(Deserialize)]
struct CompileRequest {
    source: String,
}

#[derive(Serialize)]
struct CompileResponse {
    cpp: String,
    output: String,
    success: bool,
    compilation_id: u64,
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "alive",
        service: "flow-chat",
        version: VERSION,
        phi: PHI,
        compilations: COMPILATIONS.load(Ordering::Relaxed),
    })
}

async fn compile_flow(Json(req): Json<CompileRequest>) -> Json<CompileResponse> {
    let id = COMPILATIONS.fetch_add(1, Ordering::Relaxed) + 1;
    let cpp = transpiler::transpile(&req.source);

    // Try to compile and run
    let (output, success) = compile_and_run(&cpp);

    Json(CompileResponse {
        cpp,
        output,
        success,
        compilation_id: id,
    })
}

fn compile_and_run(cpp_source: &str) -> (String, bool) {
    let src_path = "/tmp/flow_chat_tmp.cpp";
    let bin_path = "/tmp/flow_chat_tmp";

    if std::fs::write(src_path, cpp_source).is_err() {
        return ("Failed to write temp file".into(), false);
    }

    match Command::new("g++")
        .args(["-std=c++17", "-o", bin_path, src_path])
        .output()
    {
        Ok(out) if out.status.success() => {
            match Command::new(bin_path).output() {
                Ok(run) => {
                    let stdout = String::from_utf8_lossy(&run.stdout).to_string();
                    let stderr = String::from_utf8_lossy(&run.stderr).to_string();
                    if run.status.success() {
                        (if stdout.is_empty() { "(no output)".into() } else { stdout }, true)
                    } else {
                        (format!("Runtime error:\n{stderr}"), false)
                    }
                }
                Err(e) => (format!("Failed to run: {e}"), false),
            }
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            (format!("Compilation error:\n{stderr}"), false)
        }
        Err(_) => ("g++ not found".into(), false),
    }
}

async fn ws_handler(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(handle_ws)
}

async fn handle_ws(mut socket: WebSocket) {
    let welcome = serde_json::json!({
        "type": "info",
        "message": "FLOW COMPILER v2.0 — Flow-to-C++17. Type Flow code.",
        "phi": PHI,
    });
    let _ = socket
        .send(Message::Text(welcome.to_string().into()))
        .await;

    while let Some(Ok(msg)) = socket.recv().await {
        if let Message::Text(text) = msg {
            let source = text.trim().to_string();
            if source.is_empty() {
                continue;
            }

            let id = COMPILATIONS.fetch_add(1, Ordering::Relaxed) + 1;
            let cpp = transpiler::transpile(&source);
            let (output, success) = compile_and_run(&cpp);

            let resp = serde_json::json!({
                "type": "compiled",
                "flow": source,
                "cpp": cpp,
                "output": output,
                "compiled": success,
                "compilation_id": id,
            });

            if socket
                .send(Message::Text(resp.to_string().into()))
                .await
                .is_err()
            {
                break;
            }
        }
    }
}

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(9602);

    let app = Router::new()
        .route("/health", get(health))
        .route("/status", get(health))
        .route("/api/compile", post(compile_flow))
        .route("/ws", get(ws_handler))
        .fallback_service(ServeDir::new("static"));

    println!("[flow-chat] Listening on 0.0.0.0:{port}");
    println!("[flow-chat] phi = {PHI}");

    let listener = TcpListener::bind(format!("0.0.0.0:{port}"))
        .await
        .expect("Failed to bind");
    axum::serve(listener, app).await.expect("Server failed");
}
