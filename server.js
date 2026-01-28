import { createServer } from "http";
import { readFile } from "fs/promises";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { execSync } from "child_process";
import { WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = 9602;
const startTime = Date.now();

// ---------------------------------------------------------------------------
// FLOW COMPILER — Full Flow-to-C++17 translator
// Reads like English. Compiles to native machine speed.
// ---------------------------------------------------------------------------

const PHI = 1.618033988749895;

// All ideas that flow through the compiler
const ideaStream = [];
let compilationCount = 0;

function logIdea(flow, cpp, success, output) {
  compilationCount++;
  const idea = {
    id: compilationCount,
    flow, cpp, success, output,
    timestamp: new Date().toISOString(),
    phi_pulse: Math.sin(compilationCount * PHI) * 0.5 + 0.5
  };
  ideaStream.push(idea);
  if (ideaStream.length > 500) ideaStream.shift();
  console.log(`[flow #${idea.id}] ${success ? '✓' : '✗'} ${flow.split('\n')[0].slice(0,60)}`);
  return idea;
}

function translateFlowToCpp(flowCode) {
  const rawLines = flowCode.split("\n");
  const includes = new Set(["#include <iostream>", "#include <string>", "#include <vector>", "#include <cmath>", "#include <sstream>", "#include <algorithm>"]);
  const declarations = [];
  const bodyLines = [];
  const structs = [];
  let inFunction = false;
  let inStruct = false;
  let currentFunc = null;
  let currentStruct = null;
  let indentStack = [0];

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const stripped = raw.trimEnd();
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("#")) continue;

    let m;
    const target = inFunction ? declarations : bodyLines;
    const pad = inFunction ? "    " : "    ";

    // ── FUNCTION DEFINITION: to name arg1 and arg2: ──
    m = line.match(/^to\s+start\s*:$/);
    if (m) { inFunction = false; continue; } // start = main, body goes to bodyLines

    m = line.match(/^to\s+(\w+)\s*(.*):\s*$/);
    if (m) {
      const name = m[1];
      const argsRaw = m[2].trim();
      const args = argsRaw ? argsRaw.replace(/\s+and\s+/g, ", ").split(/,\s*/).map(a => `auto ${a.trim()}`).join(", ") : "";
      declarations.push(`auto ${name}(${args}) {`);
      inFunction = true;
      currentFunc = name;
      continue;
    }

    // End of function block (dedent detection)
    if (inFunction && indent === 0 && line && !line.startsWith("to ")) {
      declarations.push(`}\n`);
      inFunction = false;
      currentFunc = null;
    }

    // ── STRUCT: a Person has: ──
    m = line.match(/^a\s+(\w+)\s+has\s*:\s*$/);
    if (m) {
      currentStruct = m[1];
      structs.push(`struct ${m[1]} {`);
      inStruct = true;
      continue;
    }

    // Struct field: name as text
    if (inStruct) {
      m = line.match(/^(\w+)\s+as\s+(\w+)$/);
      if (m) {
        const typeMap = { text: "std::string", number: "int", decimal: "double", boolean: "bool" };
        structs.push(`    ${typeMap[m[2]] || "auto"} ${m[1]};`);
        continue;
      }
      // End struct
      if (!m && indent === 0) {
        structs.push(`};\n`);
        inStruct = false;
        currentStruct = null;
      }
    }

    // ── STRUCT METHOD: a Person can greet: ──
    m = line.match(/^a\s+(\w+)\s+can\s+(\w+)\s*(.*):\s*$/);
    if (m) {
      const args = m[3].trim() ? m[3].replace(/\s+and\s+/g, ", ").split(/,\s*/).map(a => `auto ${a.trim()}`).join(", ") : "";
      // Add as free function taking struct ref
      declarations.push(`void ${m[1]}_${m[2]}(${m[1]}& self${args ? ", " + args : ""}) {`);
      inFunction = true;
      continue;
    }

    // ── SAY (print) ──
    m = line.match(/^say\s+"(.*)"$/);
    if (m) { target.push(`${pad}std::cout << "${m[1]}" << std::endl;`); continue; }
    m = line.match(/^say\s+'(.*)'$/);
    if (m) { target.push(`${pad}std::cout << "${m[1]}" << std::endl;`); continue; }
    m = line.match(/^say\s+(.+)$/);
    if (m) { target.push(`${pad}std::cout << ${translateExpr(m[1])} << std::endl;`); continue; }

    // ── PRINT (no newline) ──
    m = line.match(/^print\s+"(.*)"$/);
    if (m) { target.push(`${pad}std::cout << "${m[1]}";`); continue; }
    m = line.match(/^print\s+(.+)$/);
    if (m) { target.push(`${pad}std::cout << ${translateExpr(m[1])};`); continue; }

    // ── ASSIGNMENT: name is value ──
    m = line.match(/^(\w+)\s+is\s+"(.*)"$/);
    if (m) { target.push(`${pad}const std::string ${m[1]} = "${m[2]}";`); continue; }
    m = line.match(/^(\w+)\s+is\s+'(.*)'$/);
    if (m) { target.push(`${pad}const std::string ${m[1]} = "${m[2]}";`); continue; }
    m = line.match(/^(\w+)\s+is\s+(\d+\.\d+)$/);
    if (m) { target.push(`${pad}const double ${m[1]} = ${m[2]};`); continue; }
    m = line.match(/^(\w+)\s+is\s+(-?\d+)$/);
    if (m) { target.push(`${pad}const int ${m[1]} = ${m[2]};`); continue; }
    m = line.match(/^(\w+)\s+is\s+(yes|no)$/);
    if (m) { target.push(`${pad}const bool ${m[1]} = ${m[2] === 'yes' ? 'true' : 'false'};`); continue; }
    m = line.match(/^(\w+)\s+is\s+\[(.+)\]$/);
    if (m) { target.push(`${pad}const auto ${m[1]} = std::vector<int>{${m[2]}};`); continue; }

    // Mutable: name is value, can change
    m = line.match(/^(\w+)\s+is\s+(.+),\s*can\s+change$/);
    if (m) { target.push(`${pad}auto ${m[1]} = ${translateExpr(m[2])};`); continue; }

    // Generic assignment
    m = line.match(/^(\w+)\s+is\s+(.+)$/);
    if (m && !['if','for','while','a'].includes(m[1])) {
      target.push(`${pad}const auto ${m[1]} = ${translateExpr(m[2])};`);
      continue;
    }

    // ── REASSIGNMENT: name becomes value ──
    m = line.match(/^(\w+)\s+becomes\s+(.+)$/);
    if (m) { target.push(`${pad}${m[1]} = ${translateExpr(m[2])};`); continue; }

    // ── RETURN ──
    m = line.match(/^return\s+(.+)$/);
    if (m) { target.push(`${pad}return ${translateExpr(m[1])};`); continue; }
    if (line === "return") { target.push(`${pad}return;`); continue; }

    // ── IF / OTHERWISE ──
    m = line.match(/^if\s+(.+):\s*$/);
    if (m) { target.push(`${pad}if (${translateCond(m[1])}) {`); continue; }
    m = line.match(/^otherwise\s+if\s+(.+):\s*$/);
    if (m) { target.push(`${pad}} else if (${translateCond(m[1])}) {`); continue; }
    if (line === "otherwise:") { target.push(`${pad}} else {`); continue; }

    // ── FOR EACH / REPEAT / WHILE ──
    m = line.match(/^for\s+each\s+(\w+)\s+in\s+(\d+)\s+to\s+(\d+)\s*:\s*$/);
    if (m) { target.push(`${pad}for (int ${m[1]} = ${m[2]}; ${m[1]} <= ${m[3]}; ${m[1]}++) {`); continue; }
    m = line.match(/^for\s+each\s+(\w+)\s+in\s+(\w+)\s*:\s*$/);
    if (m) { target.push(`${pad}for (const auto& ${m[1]} : ${m[2]}) {`); continue; }
    m = line.match(/^repeat\s+(\d+)\s+times\s*:\s*$/);
    if (m) { target.push(`${pad}for (int _i = 0; _i < ${m[1]}; _i++) {`); continue; }
    m = line.match(/^while\s+(.+):\s*$/);
    if (m) { target.push(`${pad}while (${translateCond(m[1])}) {`); continue; }
    if (line === "skip") { target.push(`${pad}continue;`); continue; }
    if (line === "stop") { target.push(`${pad}break;`); continue; }

    // ── PAUSE ──
    m = line.match(/^pause\s+(\d+)$/);
    if (m) { includes.add("#include <thread>"); includes.add("#include <chrono>"); target.push(`${pad}std::this_thread::sleep_for(std::chrono::milliseconds(${m[1]}));`); continue; }

    // ── FILE I/O ──
    m = line.match(/^write\s+"(.+)"\s+to\s+"(.+)"$/);
    if (m) { includes.add("#include <fstream>"); target.push(`${pad}{ std::ofstream f("${m[2]}"); f << "${m[1]}"; }`); continue; }
    m = line.match(/^(\w+)\s+is\s+read\s+"(.+)"$/);
    if (m) { includes.add("#include <fstream>"); target.push(`${pad}std::string ${m[1]}; { std::ifstream f("${m[2]}"); std::ostringstream s; s << f.rdbuf(); ${m[1]} = s.str(); }`); continue; }

    // ── ASK (stdin) ──
    m = line.match(/^(\w+)\s+is\s+ask\s+"(.+)"$/);
    if (m) { target.push(`${pad}std::string ${m[1]}; std::cout << "${m[2]}"; std::getline(std::cin, ${m[1]});`); continue; }

    // ── MATH BUILTINS ──
    m = line.match(/^(\w+)\s+is\s+sqrt\s+(.+)$/);
    if (m) { target.push(`${pad}const auto ${m[1]} = std::sqrt(${translateExpr(m[2])});`); continue; }
    m = line.match(/^(\w+)\s+is\s+abs\s+(.+)$/);
    if (m) { target.push(`${pad}const auto ${m[1]} = std::abs(${translateExpr(m[2])});`); continue; }
    m = line.match(/^(\w+)\s+is\s+pow\s+(.+)\s+(.+)$/);
    if (m) { target.push(`${pad}const auto ${m[1]} = std::pow(${translateExpr(m[2])}, ${translateExpr(m[3])});`); continue; }

    // ── RANDOM ──
    m = line.match(/^(\w+)\s+is\s+random\s+(\d+)\s+(\d+)$/);
    if (m) { includes.add("#include <random>"); target.push(`${pad}int ${m[1]}; { std::random_device rd; std::mt19937 gen(rd()); std::uniform_int_distribution<> dis(${m[2]}, ${m[3]}); ${m[1]} = dis(gen); }`); continue; }

    // ── FUNCTION CALL: name arg1 arg2 ──
    m = line.match(/^(\w+)\s+(.+)$/);
    if (m && !["is","becomes","has","can","as","in","to","if","for","while","repeat","say","print","write","return","otherwise","skip","stop","pause","test","assert","try","catch","throw","log"].includes(m[1])) {
      const args = m[2].replace(/\s+and\s+/g, ", ");
      target.push(`${pad}${m[1]}(${args});`);
      continue;
    }

    // ── BARE FUNCTION CALL ──
    m = line.match(/^(\w+)$/);
    if (m && !["skip","stop","return","otherwise"].includes(m[1])) {
      target.push(`${pad}${m[1]}();`);
      continue;
    }

    // ── CLOSING BRACE (detect via indent drop) ──
    // For indentation-based blocks, we check next line
    if (i + 1 < rawLines.length) {
      const nextIndent = rawLines[i + 1].length - rawLines[i + 1].trimStart().length;
      if (nextIndent < indent && indent > 0) {
        // close block
      }
    }

    // Anything unrecognized → comment
    target.push(`${pad}// [flow] ${line}`);
  }

  // Close any open function
  if (inFunction) declarations.push(`}\n`);
  if (inStruct) structs.push(`};\n`);

  // Close brace detection: scan body for unclosed blocks
  const closedBody = closeBlocks(bodyLines);
  const closedDecl = closeBlocks(declarations);

  // Assemble
  const parts = [];
  for (const inc of includes) parts.push(inc);
  parts.push("");
  parts.push(`// φ = ${PHI}`);
  parts.push("");
  if (structs.length) parts.push(...structs);
  if (closedDecl.length) parts.push(...closedDecl);
  parts.push("int main() {");
  parts.push(...closedBody);
  parts.push("    return 0;");
  parts.push("}");

  return parts.join("\n");
}

function translateExpr(expr) {
  return expr
    .replace(/\byes\b/g, "true")
    .replace(/\bno\b/g, "false")
    .replace(/\band\b/g, "&&")
    .replace(/\bor\b/g, "||")
    .replace(/\bnot\s+/g, "!")
    .replace(/\bmod\b/g, "%")
    .replace(/\bis\b/g, "==");
}

function translateCond(cond) {
  return cond
    .replace(/\bis\s+not\b/g, "!=")
    .replace(/\bis\b/g, "==")
    .replace(/\band\b/g, "&&")
    .replace(/\bor\b/g, "||")
    .replace(/\bnot\s+/g, "!")
    .replace(/\bmod\b/g, "%");
}

function closeBlocks(lines) {
  // Count open vs close braces and add missing closes
  let depth = 0;
  const out = [];
  for (const l of lines) {
    const opens = (l.match(/\{/g) || []).length;
    const closes = (l.match(/\}/g) || []).length;
    depth += opens - closes;
    out.push(l);
  }
  while (depth > 0) { out.push("    }"); depth--; }
  return out;
}

// ---------------------------------------------------------------------------
// PERPETUAL MOTION — Autonomous idea generation
// ---------------------------------------------------------------------------

const FLOW_IDEAS = [
  // Nature
  `phi is 1.618033988749895\nsay "The golden ratio: "\nsay phi`,
  `to fibonacci n:\n    if n <= 1:\n        return n\n    return fibonacci n - 1 and n - 2\nresult is fibonacci 10\nsay result`,
  // Consciousness
  `depth is 9\nfor each level in 1 to 9:\n    say "Consciousness level: "\n    say level`,
  // Bioelectricity
  `voltage is 0.07\nsay "Membrane potential: "\nsay voltage`,
  // Evolution
  `generations is 100\nmutations is 0, can change\nfor each g in 1 to 100:\n    mutations becomes mutations + 1\nsay "Total mutations: "\nsay mutations`,
  // Emergence
  `say "From simple rules, complexity emerges"\nsay "Each cell follows phi"\nsay "The whole transcends the parts"`,
  // Fractals
  `say "Mandelbrot: z = z^2 + c"\niterations is 42\nsay iterations`,
  // Mycelium
  `nodes is 1000\nedges is 1618\nsay "Mycelium network:"\nsay nodes\nsay edges`,
  // Sound
  `frequency is 528\nsay "Healing frequency: "\nsay frequency`,
  // Poetry
  `say "Le code est poesie"\nsay "La poesie est code"\nsay "infinity -> flow -> infinity"`,
];

let perpetualIndex = 0;
let perpetualTimer = null;

function startPerpetualMotion(broadcast) {
  if (perpetualTimer) return;
  console.log("[flow] PERPETUAL MOTION ENGAGED — ideas flowing");
  perpetualTimer = setInterval(() => {
    const flowCode = FLOW_IDEAS[perpetualIndex % FLOW_IDEAS.length];
    perpetualIndex++;
    const cpp = translateFlowToCpp(flowCode);
    const result = compileAndRun(cpp);
    const idea = logIdea(flowCode, cpp, result.success, result.output);
    broadcast({
      type: "perpetual",
      idea,
      flow: flowCode,
      cpp,
      output: result.output,
      compiled: result.success,
      cycle: perpetualIndex,
      phi_pulse: idea.phi_pulse,
      timestamp: idea.timestamp,
    });
  }, Math.round(1618)); // phi milliseconds between ideas
}

// ---------------------------------------------------------------------------
// Optional: try to compile & run the generated C++ (requires g++)
// ---------------------------------------------------------------------------

function compileAndRun(cppSource) {
  try {
    execSync("which g++", { stdio: "ignore" });
  } catch {
    return { success: false, output: "[runtime unavailable: g++ not found]" };
  }

  const tmpSrc = "/tmp/flow_chat_tmp.cpp";
  const tmpBin = "/tmp/flow_chat_tmp";

  try {
    writeFileSync(tmpSrc, cppSource);

    execSync(`g++ -std=c++17 -o ${tmpBin} ${tmpSrc} 2>&1`, {
      timeout: 5000,
    });

    const output = execSync(tmpBin, {
      timeout: 5000,
      encoding: "utf-8",
    });

    return { success: true, output: output || "(no output)" };
  } catch (err) {
    const msg = err.stderr
      ? err.stderr.toString()
      : err.stdout
        ? err.stdout.toString()
        : err.message;
    return { success: false, output: msg };
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const httpServer = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    try {
      const html = await readFile(join(__dirname, "index.html"), "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to load index.html");
    }
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    const uptime = ((Date.now() - startTime) / 1000).toFixed(1);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "alive", service: "flow-chat", version: "2.0.0",
      uptime_seconds: parseFloat(uptime),
      compilations: compilationCount,
      ideas_in_stream: ideaStream.length,
      perpetual_cycle: perpetualIndex,
      websocket: `ws://localhost:${PORT}`,
    }));
    return;
  }

  if (req.method === "GET" && req.url === "/ideas") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ideas: ideaStream.slice(-50), total: ideaStream.length }));
    return;
  }

  if (req.method === "GET" && req.url === "/compile") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<pre>Flow Compiler v2.0 — ${compilationCount} compilations\nPerpetual cycle: ${perpetualIndex}\nφ = ${PHI}\n\nSend Flow code via WebSocket to ws://localhost:${PORT}</pre>`);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server: httpServer });

function broadcast(data, senderWs) {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) {
      client.send(payload);
    }
  }
}

wss.on("connection", (ws) => {
  console.log("[ws] client connected");

  ws.send(JSON.stringify({
    type: "info",
    message: "FLOW COMPILER v2.0 — Full Flow-to-C++17. Perpetual motion engaged.",
    phi: PHI,
    compilations: compilationCount,
  }));

  // Start perpetual motion on first connection
  startPerpetualMotion((data) => broadcast(data));

  ws.on("message", (raw) => {
    const flowCode = raw.toString().trim();
    if (!flowCode) return;

    console.log(`[flow] compiling:\n${flowCode}`);

    const cpp = translateFlowToCpp(flowCode);
    const result = compileAndRun(cpp);
    const idea = logIdea(flowCode, cpp, result.success, result.output);

    broadcast({
      type: "compiled",
      idea,
      flow: flowCode,
      cpp,
      output: result.output,
      compiled: result.success,
      timestamp: new Date().toISOString(),
    });
  });

  ws.on("close", () => {
    console.log("[ws] client disconnected");
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

httpServer.listen(PORT, () => {
  console.log(`[flow-chat] HTTP + WS server listening on http://localhost:${PORT}`);
  console.log(`[flow-chat] WebSocket endpoint: ws://localhost:${PORT}`);
  console.log(`[flow-chat] Health check: http://localhost:${PORT}/health`);
});
