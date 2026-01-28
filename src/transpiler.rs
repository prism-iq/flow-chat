/// Flow-to-C++ transpiler — line-by-line translation
/// Handles: say, let, if/then/else/end, loop/times/end, define/end, return, comments

const PHI: &str = "1.6180339887498948";

pub fn transpile(source: &str) -> String {
    let mut cpp_lines: Vec<String> = Vec::new();
    let mut includes = IncludeSet::default();
    let mut in_function = false;
    let mut in_main = false;
    let mut indent: usize = 1;
    let mut body_lines: Vec<String> = Vec::new();
    let mut top_lines: Vec<String> = Vec::new();

    for raw_line in source.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        // Comment
        if line.starts_with("--") {
            let comment = &line[2..].trim_start();
            let target = if in_function { &mut top_lines } else { &mut body_lines };
            push_to(target, indent, &format!("// {comment}"));
            continue;
        }

        // end
        if line == "end" {
            if indent > 0 {
                indent -= 1;
            }
            let target = if in_function { &mut top_lines } else { &mut body_lines };
            push_to(target, indent, "}");
            if in_function && indent == 0 {
                in_function = false;
                top_lines.push(String::new());
            }
            continue;
        }

        // define func(args)
        if line.starts_with("define ") {
            in_function = true;
            indent = 0;
            let rest = &line[7..];
            let (name, params) = parse_func_signature(rest);
            let param_str = params
                .iter()
                .map(|p| format!("auto {p}"))
                .collect::<Vec<_>>()
                .join(", ");
            push_to(&mut top_lines, 0, &format!("auto {name}({param_str}) {{"));
            indent = 1;
            continue;
        }

        // return
        if line.starts_with("return ") {
            let val = translate_expr(&line[7..], &mut includes);
            let target = if in_function { &mut top_lines } else { &mut body_lines };
            push_to(target, indent, &format!("return {val};"));
            continue;
        }

        // say
        if line.starts_with("say ") {
            includes.iostream = true;
            let expr = translate_expr(&line[4..], &mut includes);
            let target = if in_function { &mut top_lines } else { &mut body_lines };
            push_to(target, indent, &format!("std::cout << {expr} << std::endl;"));
            continue;
        }

        // let x = value
        if line.starts_with("let ") {
            let rest = &line[4..];
            if let Some(eq_pos) = rest.find('=') {
                let name = rest[..eq_pos].trim();
                let val = translate_expr(rest[eq_pos + 1..].trim(), &mut includes);
                let target = if in_function { &mut top_lines } else { &mut body_lines };
                push_to(target, indent, &format!("auto {name} = {val};"));
            }
            continue;
        }

        // if cond then
        if line.starts_with("if ") && line.ends_with("then") {
            let cond = &line[3..line.len() - 4].trim();
            let cond_cpp = translate_expr(cond, &mut includes);
            let target = if in_function { &mut top_lines } else { &mut body_lines };
            push_to(target, indent, &format!("if ({cond_cpp}) {{"));
            indent += 1;
            continue;
        }

        // else
        if line == "else" {
            if indent > 0 {
                indent -= 1;
            }
            let target = if in_function { &mut top_lines } else { &mut body_lines };
            push_to(target, indent, "} else {");
            indent += 1;
            continue;
        }

        // loop N times
        if line.starts_with("loop ") && line.ends_with("times") {
            let n = &line[5..line.len() - 5].trim();
            let n_cpp = translate_expr(n, &mut includes);
            let target = if in_function { &mut top_lines } else { &mut body_lines };
            push_to(
                target,
                indent,
                &format!("for (int _i = 0; _i < {n_cpp}; _i++) {{"),
            );
            indent += 1;
            continue;
        }

        // while cond do
        if line.starts_with("while ") && line.ends_with("do") {
            let cond = &line[6..line.len() - 2].trim();
            let cond_cpp = translate_expr(cond, &mut includes);
            let target = if in_function { &mut top_lines } else { &mut body_lines };
            push_to(target, indent, &format!("while ({cond_cpp}) {{"));
            indent += 1;
            continue;
        }

        // grow x
        if line.starts_with("grow ") {
            let var = &line[5..].trim();
            let target = if in_function { &mut top_lines } else { &mut body_lines };
            push_to(target, indent, &format!("{var} *= {PHI};"));
            continue;
        }

        // break / continue
        if line == "break" {
            let target = if in_function { &mut top_lines } else { &mut body_lines };
            push_to(target, indent, "break;");
            continue;
        }
        if line == "continue" {
            let target = if in_function { &mut top_lines } else { &mut body_lines };
            push_to(target, indent, "continue;");
            continue;
        }

        // Fallback: expression statement
        let expr = translate_expr(line, &mut includes);
        let target = if in_function { &mut top_lines } else { &mut body_lines };
        push_to(target, indent, &format!("{expr};"));
    }

    // Assemble
    cpp_lines.push("// Generated by flowc — the Flow compiler".into());
    if includes.iostream {
        cpp_lines.push("#include <iostream>".into());
    }
    if includes.string {
        cpp_lines.push("#include <string>".into());
    }
    if includes.cmath {
        cpp_lines.push("#include <cmath>".into());
    }
    cpp_lines.push(String::new());

    for l in &top_lines {
        cpp_lines.push(l.clone());
    }

    cpp_lines.push("int main() {".into());
    for l in &body_lines {
        cpp_lines.push(l.clone());
    }
    cpp_lines.push("    return 0;".into());
    cpp_lines.push("}".into());

    cpp_lines.join("\n") + "\n"
}

fn push_to(buf: &mut Vec<String>, indent: usize, text: &str) {
    let pad = "    ".repeat(indent);
    buf.push(format!("{pad}{text}"));
}

fn parse_func_signature(s: &str) -> (String, Vec<String>) {
    let s = s.trim();
    if let Some(paren) = s.find('(') {
        let name = s[..paren].trim().to_string();
        let end = s.find(')').unwrap_or(s.len());
        let params: Vec<String> = s[paren + 1..end]
            .split(',')
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect();
        (name, params)
    } else {
        (s.to_string(), vec![])
    }
}

fn translate_expr(s: &str, includes: &mut IncludeSet) -> String {
    let s = s.trim();

    // phi keyword
    if s == "phi" {
        return PHI.to_string();
    }

    // String literal
    if s.starts_with('"') && s.ends_with('"') {
        includes.string = true;
        return format!("std::string({s})");
    }

    // Boolean
    if s == "true" {
        return "true".into();
    }
    if s == "false" {
        return "false".into();
    }

    // Number
    if s.parse::<f64>().is_ok() {
        return s.to_string();
    }

    // Power operator
    if s.contains(" ^ ") {
        includes.cmath = true;
        let parts: Vec<&str> = s.splitn(2, " ^ ").collect();
        let left = translate_expr(parts[0], includes);
        let right = translate_expr(parts[1], includes);
        return format!("std::pow({left}, {right})");
    }

    // Boolean ops
    let s = s
        .replace(" and ", " && ")
        .replace(" or ", " || ")
        .replace("not ", "!");

    s
}

#[derive(Default)]
struct IncludeSet {
    iostream: bool,
    string: bool,
    cmath: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_say() {
        let out = transpile("say \"hello\"");
        assert!(out.contains("std::cout"));
        assert!(out.contains("hello"));
    }

    #[test]
    fn test_let() {
        let out = transpile("let x = 42");
        assert!(out.contains("auto x = 42;"));
    }

    #[test]
    fn test_phi() {
        let out = transpile("say phi");
        assert!(out.contains(PHI));
    }
}
