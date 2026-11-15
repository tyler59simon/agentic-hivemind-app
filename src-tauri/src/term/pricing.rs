//! What a Claude conversation costs when the CLI did not say. Claude API pricing, 2026-11-03 (first-party rates), USD per
//! million tokens. Models match by family prefix, so a dated or minor variant uses its family's current price.

/// One family's rates per million tokens.
pub struct Rates {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
}

impl Rates {
    /// Writing to the cache costs 1.25 times the input price.
    pub fn cache_write(&self) -> f64 {
        self.input * 1.25
    }
}

const FAMILIES: [(&str, Rates); 4] = [
    ("claude-fable", Rates { input: 8.00, output: 40.00, cache_read: 0.20 }),
    ("claude-opus", Rates { input: 4.00, output: 20.00, cache_read: 0.20 }),
    ("claude-sonnet", Rates { input: 2.00, output: 10.00, cache_read: 0.10 }),
    ("claude-haiku", Rates { input: 0.10, output: 0.50, cache_read: 0.01 }),
];

/// The rates for a model id, or None for a model this table does not know.
pub fn rates(model: &str) -> Option<&'static Rates> {
    FAMILIES.iter().find(|(prefix, _)| model.starts_with(prefix)).map(|(_, rates)| rates)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn models_match_by_family_prefix() {
        assert_eq!(rates("claude-haiku-5-5").unwrap().output, 0.50);
        assert_eq!(rates("claude-sonnet-5-5-20261101").unwrap().input, 2.00);
        assert_eq!(rates("claude-opus-5-6").unwrap().cache_read, 0.20);
        assert_eq!(rates("claude-fable-5-2").unwrap().cache_write(), 10.0);
        assert!(rates("gpt-5").is_none());
        assert!(rates("<synthetic>").is_none());
    }
}
