//! Tokens, cost and plan limits of a terminal session, read from the CLI's own conversation file in one pass. Lines that
//! cannot matter are skipped with a substring test before any JSON parsing.
use super::pricing;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::BufRead;
use std::path::Path;

/// One plan window of Codex's `rate_limits`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    pub used_percent: f64,
    pub window_minutes: u64,
    pub resets_at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Limits {
    pub primary: Option<Window>,
    pub secondary: Option<Window>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_tokens: u64,
    pub cost_usd: Option<f64>,
    pub cost_exact: bool,
    pub limits: Option<Limits>,
}

fn num(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

#[derive(Default, Clone)]
struct Counts {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
}

/// Feed the lines of a Claude Code transcript, then `finish`.
#[derive(Default)]
pub struct ClaudeUsage {
    /// By message id; a streamed message is written several times and the last record wins.
    messages: HashMap<String, (Counts, String)>,
    unnamed: u64,
    /// The last `cost-state`: total cost and, when it lists models, their summed tokens.
    state: Option<(f64, Option<Counts>)>,
}

impl ClaudeUsage {
    pub fn feed(&mut self, line: &str) {
        if !line.contains("\"cost-state\"") && !(line.contains("\"usage\"") && line.contains("\"assistant\"")) {
            return;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else { return };
        match record.get("type").and_then(Value::as_str) {
            Some("cost-state") => {
                let Some(total) = record.get("totalCostUSD").and_then(Value::as_f64) else { return };
                let counts = record.get("modelUsage").and_then(Value::as_object).filter(|m| !m.is_empty()).map(|models| {
                    models.values().fold(Counts::default(), |mut sum, m| {
                        sum.input += num(m, "inputTokens");
                        sum.output += num(m, "outputTokens");
                        sum.cache_read += num(m, "cacheReadInputTokens");
                        sum.cache_write += num(m, "cacheCreationInputTokens");
                        sum
                    })
                });
                self.state = Some((total, counts));
            }
            Some("assistant") => {
                let message = &record["message"];
                let Some(usage) = message.get("usage").filter(|u| u.is_object()) else { return };
                let id = match message.get("id").and_then(Value::as_str) {
                    Some(id) => id.to_string(),
                    None => {
                        self.unnamed += 1;
                        format!("\0{}", self.unnamed)
                    }
                };
                let counts = Counts {
                    input: num(usage, "input_tokens"),
                    output: num(usage, "output_tokens"),
                    cache_read: num(usage, "cache_read_input_tokens"),
                    cache_write: num(usage, "cache_creation_input_tokens"),
                };
                let model = message.get("model").and_then(Value::as_str).unwrap_or("").to_string();
                self.messages.insert(id, (counts, model));
            }
            _ => {}
        }
    }

    pub fn finish(self) -> Usage {
        let mut counted = Counts::default();
        let mut cost = Some(0.0);
        for (counts, model) in self.messages.values() {
            counted.input += counts.input;
            counted.output += counts.output;
            counted.cache_read += counts.cache_read;
            counted.cache_write += counts.cache_write;
            cost = match (cost, pricing::rates(model)) {
                (Some(sum), Some(r)) => Some(
                    sum + (counts.input as f64 * r.input
                        + counts.output as f64 * r.output
                        + counts.cache_read as f64 * r.cache_read
                        + counts.cache_write as f64 * r.cache_write())
                        / 1e6,
                ),
                _ => None,
            };
        }
        let (counts, cost_usd, cost_exact) = match self.state {
            Some((total, counts)) => (counts.unwrap_or(counted), Some(total), true),
            None => (counted, if self.messages.is_empty() { None } else { cost }, false),
        };
        Usage {
            input_tokens: counts.input + counts.cache_write,
            output_tokens: counts.output,
            cached_tokens: counts.cache_read,
            cost_usd,
            cost_exact,
            limits: None,
        }
    }
}

/// Feed the lines of a Codex rollout, then `finish`. Codex on a ChatGPT plan is not billed per token, so there is no cost.
#[derive(Default)]
pub struct CodexUsage {
    total: Option<Value>,
    limits: Option<Limits>,
}

fn window(value: Option<&Value>) -> Option<Window> {
    let value = value.filter(|v| v.is_object())?;
    Some(Window {
        used_percent: value.get("used_percent").and_then(Value::as_f64)?,
        window_minutes: num(value, "window_minutes"),
        resets_at: num(value, "resets_at"),
    })
}

impl CodexUsage {
    pub fn feed(&mut self, line: &str) {
        if !line.contains("\"token_count\"") {
            return;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else { return };
        let payload = &record["payload"];
        if payload.get("type").and_then(Value::as_str) != Some("token_count") {
            return;
        }
        if let Some(total) = payload.get("info").and_then(|info| info.get("total_token_usage")).filter(|t| t.is_object()) {
            self.total = Some(total.clone());
        }
        if let Some(limits) = payload.get("rate_limits").filter(|l| l.is_object()) {
            let (primary, secondary) = (window(limits.get("primary")), window(limits.get("secondary")));
            if primary.is_some() || secondary.is_some() {
                self.limits = Some(Limits { primary, secondary });
            }
        }
    }

    pub fn finish(self) -> Usage {
        let total = self.total.unwrap_or(Value::Null);
        let cached = num(&total, "cached_input_tokens");
        Usage {
            // Codex counts cached tokens inside `input_tokens`; they are reported on their own here.
            input_tokens: num(&total, "input_tokens").saturating_sub(cached),
            output_tokens: num(&total, "output_tokens"),
            cached_tokens: cached,
            cost_usd: None,
            cost_exact: false,
            limits: self.limits,
        }
    }
}

/// Stream a file's lines (bytes that are not UTF-8 are replaced) into `feed`.
pub fn read_lines(path: &Path, mut feed: impl FnMut(&str)) -> Result<(), String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Could not read the conversation file: {e}"))?;
    let mut reader = std::io::BufReader::new(file);
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        match reader.read_until(b'\n', &mut buffer) {
            Ok(0) => return Ok(()),
            Ok(_) => feed(&String::from_utf8_lossy(&buffer)),
            Err(e) => return Err(format!("Could not read the conversation file: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claude(lines: &[&str]) -> Usage {
        let mut usage = ClaudeUsage::default();
        lines.iter().for_each(|l| usage.feed(l));
        usage.finish()
    }

    fn codex(lines: &[&str]) -> Usage {
        let mut usage = CodexUsage::default();
        lines.iter().for_each(|l| usage.feed(l));
        usage.finish()
    }

    const A1: &str = r#"{"type":"assistant","message":{"id":"m1","model":"claude-haiku-5-5","usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}"#;
    const A1_FINAL: &str = r#"{"type":"assistant","message":{"id":"m1","model":"claude-haiku-5-5","usage":{"input_tokens":1000000,"output_tokens":1000000,"cache_creation_input_tokens":1000000,"cache_read_input_tokens":1000000}}}"#;

    #[test]
    fn a_streamed_message_counts_once_and_the_last_record_wins() {
        let usage = claude(&[A1, "not json", r#"{"type":"user"}"#, A1_FINAL]);
        assert_eq!((usage.input_tokens, usage.output_tokens, usage.cached_tokens), (2_000_000, 1_000_000, 1_000_000));
        // 0.10 + 0.50 + 0.01 + 0.125
        assert!((usage.cost_usd.unwrap() - 0.735).abs() < 1e-9);
        assert!(!usage.cost_exact);
    }

    #[test]
    fn a_cost_state_overrides_the_estimate() {
        let state = r#"{"type":"cost-state","totalCostUSD":0.0085,"modelUsage":{"claude-haiku-5-5":{"inputTokens":2263,"outputTokens":1423}}}"#;
        let usage = claude(&[A1, state]);
        assert_eq!((usage.input_tokens, usage.output_tokens, usage.cost_usd, usage.cost_exact), (2263, 1423, Some(0.0085), true));
        // Without a model list the counted tokens stay.
        let bare = claude(&[A1, r#"{"type":"cost-state","totalCostUSD":0.5}"#]);
        assert_eq!((bare.input_tokens, bare.cost_usd, bare.cost_exact), (10, Some(0.5), true));
    }

    #[test]
    fn an_unknown_model_has_tokens_and_no_cost() {
        let usage = claude(&[A1, r#"{"type":"assistant","message":{"id":"m2","model":"mystery-1","usage":{"input_tokens":7,"output_tokens":3}}}"#]);
        assert_eq!((usage.input_tokens, usage.output_tokens, usage.cost_usd), (17, 8, None));
        assert_eq!(claude(&[]).cost_usd, None);
    }

    #[test]
    fn codex_reads_the_last_total_and_limits_and_skips_a_null_info() {
        let first = r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":10}},"rate_limits":{"primary":{"used_percent":1.0,"window_minutes":300,"resets_at":5},"secondary":{"used_percent":20.0,"window_minutes":10080,"resets_at":9}}}}"#;
        let last = r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":300,"cached_input_tokens":100,"output_tokens":30}},"rate_limits":{"primary":{"used_percent":0.0,"window_minutes":300,"resets_at":6},"secondary":{"used_percent":28.0,"window_minutes":10080,"resets_at":9}}}}"#;
        let null = r#"{"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"primary":{"used_percent":3.0,"window_minutes":300,"resets_at":7},"secondary":null}}}"#;
        let usage = codex(&[first, last]);
        assert_eq!((usage.input_tokens, usage.cached_tokens, usage.output_tokens, usage.cost_usd), (200, 100, 30, None));
        assert_eq!(usage.limits.as_ref().unwrap().secondary.as_ref().unwrap().used_percent, 28.0);
        let after = codex(&[first, last, null]);
        assert_eq!(after.input_tokens, 200);
        let limits = after.limits.unwrap();
        assert_eq!(limits.primary.unwrap().used_percent, 3.0);
        assert!(limits.secondary.is_none());
        // Only a null `info`: no tokens, limits still read.
        let only = codex(&[null]);
        assert_eq!((only.input_tokens, only.limits.is_some()), (0, true));
    }

    #[test]
    fn the_json_is_camel_case() {
        let json = serde_json::to_value(claude(&[A1])).unwrap();
        assert!(json.get("inputTokens").is_some() && json.get("costExact").is_some() && json.get("limits").is_some());
    }
}
