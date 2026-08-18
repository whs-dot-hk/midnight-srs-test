//! Cards, decks, and the content addressing that ties them to the ledger.
//!
//! The contract stores card identifiers as opaque `Bytes<32>` and never recomputes them — it
//! only tests membership in the deck's `Set`. That means the hash used here need only be
//! collision-resistant and agreed between clients; it does not have to match the circuit's
//! `persistentHash`, which operates over the BLS scalar field and would be far more awkward
//! to reproduce off-chain.
//!
//! Card *content* is public. A shared deck everyone studies is public by construction, as in
//! Anki. What this system keeps private is each learner's performance on it.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Domain separator, versioned so a future change to the encoding cannot silently collide
/// with identifiers already published on-chain.
const CARD_DOMAIN: &[u8] = b"srs:card:v1";

/// A card's 32-byte content address.
///
/// Serialises as lowercase hex, which is what the TypeScript layer converts to the
/// `Uint8Array` the contract bindings expect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CardId([u8; 32]);

impl CardId {
    /// The raw bytes.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// Lowercase hex, without a `0x` prefix.
    #[must_use]
    pub fn to_hex(self) -> String {
        let mut s = String::with_capacity(64);
        for b in self.0 {
            s.push_str(&format!("{b:02x}"));
        }
        s
    }
}

impl Serialize for CardId {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_hex())
    }
}

impl<'de> Deserialize<'de> for CardId {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let hex = String::deserialize(d)?;
        if hex.len() != 64 {
            return Err(serde::de::Error::custom(format!(
                "card id must be 64 hex characters, got {}",
                hex.len()
            )));
        }
        let mut out = [0u8; 32];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
                .map_err(|e| serde::de::Error::custom(format!("card id is not hex: {e}")))?;
        }
        Ok(Self(out))
    }
}

impl std::fmt::Display for CardId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.to_hex())
    }
}

/// One card: a prompt and its answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Card {
    /// The prompt shown to the learner.
    pub front: String,
    /// The answer revealed after recall is attempted.
    pub back: String,
}

impl Card {
    /// Construct a card.
    pub fn new(front: impl Into<String>, back: impl Into<String>) -> Self {
        Self {
            front: front.into(),
            back: back.into(),
        }
    }

    /// This card's content address.
    ///
    /// Both fields are length-prefixed before hashing, so no pair of distinct cards can
    /// produce the same preimage by shifting text across the boundary — `("ab", "c")` and
    /// `("a", "bc")` hash differently.
    #[must_use]
    pub fn id(&self) -> CardId {
        let mut hasher = Sha256::new();
        hasher.update(CARD_DOMAIN);
        for field in [&self.front, &self.back] {
            hasher.update((field.len() as u64).to_le_bytes());
            hasher.update(field.as_bytes());
        }
        CardId(hasher.finalize().into())
    }
}

/// A named collection of cards, as authored off-chain before publication.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Deck {
    /// Human-readable deck name. Not stored on-chain.
    pub name: String,
    /// The cards, in authoring order.
    pub cards: Vec<Card>,
}

impl Deck {
    /// The content addresses of every card, in authoring order.
    #[must_use]
    pub fn card_ids(&self) -> Vec<CardId> {
        self.cards.iter().map(Card::id).collect()
    }

    /// Look up a card by its content address.
    #[must_use]
    pub fn find(&self, id: CardId) -> Option<&Card> {
        self.cards.iter().find(|c| c.id() == id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_stable_and_content_addressed() {
        let a = Card::new("kanji 水", "water");
        let b = Card::new("kanji 水", "water");
        assert_eq!(a.id(), b.id());
        assert_eq!(a.id().to_hex().len(), 64);
    }

    #[test]
    fn different_content_gives_different_ids() {
        assert_ne!(Card::new("a", "b").id(), Card::new("a", "c").id());
    }

    #[test]
    fn length_prefixing_prevents_boundary_collisions() {
        assert_ne!(Card::new("ab", "c").id(), Card::new("a", "bc").id());
    }

    #[test]
    fn ids_round_trip_through_json() {
        let id = Card::new("front", "back").id();
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(serde_json::from_str::<CardId>(&json).unwrap(), id);
    }

    #[test]
    fn a_deck_finds_its_own_cards() {
        let deck = Deck {
            name: "kanji".into(),
            cards: vec![Card::new("水", "water"), Card::new("火", "fire")],
        };
        let ids = deck.card_ids();
        assert_eq!(ids.len(), 2);
        assert_eq!(deck.find(ids[1]).unwrap().back, "fire");
    }
}
