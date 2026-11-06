//! Every item a session has drawn, each in its latest state.
//!
//! This is what `attach` answers, so an agent tab that mounts late — or
//! remounts after its cluster was hidden — gets the whole conversation in one
//! reply instead of a replay of every chunk. The same [`Event`]s the tab
//! applies are applied here, in the same order, so the two cannot disagree.

use std::collections::VecDeque;

use crate::event::{Event, FileDiff, Item, ItemKind};

/// The most items kept. Past it the oldest go; a tab that attaches then sees
/// the conversation from part-way through.
pub const MAX_ITEMS: usize = 2000;

/// The most bytes of item text kept, by [`weight`]. Past it the oldest items
/// go, as they do past [`MAX_ITEMS`]: the count alone would allow
/// thousands of items of a quarter-megabyte each.
pub const MAX_BYTES: usize = 32 * 1024 * 1024;

/// The items, oldest first.
#[derive(Debug, Default, Clone)]
pub struct Transcript {
    items: VecDeque<Item>,
    /// The sum of every kept item's [`weight`].
    bytes: usize,
}

impl Transcript {
    /// A transcript continuing from `items`.
    pub fn from_items(items: Vec<Item>) -> Self {
        let bytes = items.iter().map(weight).sum();
        let mut transcript = Self {
            items: items.into(),
            bytes,
        };
        transcript.trim();
        transcript
    }

    /// Apply one event, as the tab would.
    pub fn apply(&mut self, event: &Event) {
        match event {
            Event::ItemStarted { item }
            | Event::ItemUpdated { item }
            | Event::ItemCompleted { item } => self.upsert(item),
            Event::ItemDelta { item_id, text } => {
                if let Some(
                    ItemKind::AssistantText { text: have } | ItemKind::Reasoning { text: have },
                ) = self.find_mut(item_id).map(|item| &mut item.kind)
                {
                    have.push_str(text);
                    self.bytes += text.len();
                    self.trim();
                }
            }
            Event::Reset => {
                self.items.clear();
                self.bytes = 0;
            }
            Event::Status { .. } | Event::TurnStarted { .. } | Event::TurnCompleted { .. } => {}
        }
    }

    /// One item by id.
    pub fn get(&self, id: &str) -> Option<&Item> {
        self.items.iter().rev().find(|item| item.id == id)
    }

    /// Every item, oldest first.
    pub fn items(&self) -> Vec<Item> {
        self.items.iter().cloned().collect()
    }

    fn find_mut(&mut self, id: &str) -> Option<&mut Item> {
        self.items.iter_mut().rev().find(|item| item.id == id)
    }

    fn upsert(&mut self, item: &Item) {
        let new = weight(item);
        if let Some(have) = self.find_mut(&item.id) {
            let old = weight(have);
            *have = item.clone();
            self.bytes = (self.bytes + new).saturating_sub(old);
        } else {
            self.items.push_back(item.clone());
            self.bytes += new;
        }
        self.trim();
    }

    /// Drop the oldest items while there are too many or they weigh too much,
    /// always keeping the newest.
    fn trim(&mut self) {
        while self.items.len() > 1 && (self.items.len() > MAX_ITEMS || self.bytes > MAX_BYTES) {
            if let Some(gone) = self.items.pop_front() {
                self.bytes = self.bytes.saturating_sub(weight(&gone));
            }
        }
    }
}

/// What an item costs to keep: its strings, and a little for the rest.
fn weight(item: &Item) -> usize {
    fn diffs(diffs: &[FileDiff]) -> usize {
        diffs
            .iter()
            .map(|d| d.path.len() + d.old_text.as_ref().map_or(0, String::len) + d.new_text.len())
            .sum()
    }
    fn strings(strings: &[String]) -> usize {
        strings.iter().map(String::len).sum()
    }
    let body = match &item.kind {
        ItemKind::UserMessage { text }
        | ItemKind::AssistantText { text }
        | ItemKind::Reasoning { text } => text.len(),
        ItemKind::ToolCall {
            title,
            output,
            paths,
            diffs: changes,
            ..
        } => title.len() + output.len() + strings(paths) + diffs(changes),
        ItemKind::Approval {
            title,
            detail,
            paths,
            diffs: changes,
            options,
            ..
        } => {
            title.len()
                + detail.as_ref().map_or(0, String::len)
                + strings(paths)
                + diffs(changes)
                + options.iter().map(|o| o.name.len()).sum::<usize>()
        }
        ItemKind::Question {
            message, questions, ..
        } => {
            message.len()
                + questions
                    .iter()
                    .map(|q| {
                        q.text.as_ref().map_or(0, String::len)
                            + q.choices
                                .iter()
                                .map(|c| c.label.len() + c.value.len())
                                .sum::<usize>()
                    })
                    .sum::<usize>()
        }
        ItemKind::Plan { entries } => entries.iter().map(|e| e.content.len()).sum(),
        ItemKind::Usage { .. } => 0,
        ItemKind::Error { message, .. } => message.len(),
        ItemKind::Task {
            name,
            description,
            summary,
            run,
            ..
        } => {
            name.len()
                + description.len()
                + summary.as_ref().map_or(0, String::len)
                + run.as_ref().map_or(0, |run| {
                    run.agents
                        .iter()
                        .map(|a| a.label.len() + a.result.as_ref().map_or(0, String::len) + 64)
                        .sum::<usize>()
                        + run
                            .phases
                            .iter()
                            .map(|p| p.title.len() + p.detail.as_ref().map_or(0, String::len))
                            .sum::<usize>()
                })
        }
        ItemKind::Notice {
            title, description, ..
        } => title.len() + description.as_ref().map_or(0, String::len),
        ItemKind::Compaction { summary, error, .. } => {
            summary.len() + error.as_ref().map_or(0, String::len)
        }
    };
    body + 64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(id: &str, text: &str) -> Item {
        Item {
            id: id.into(),
            turn_id: "t1".into(),
            kind: ItemKind::AssistantText { text: text.into() },
            parent: None,
        }
    }

    #[test]
    fn deltas_append_and_completion_replaces() {
        let mut t = Transcript::default();
        t.apply(&Event::ItemStarted {
            item: text("i1", "He"),
        });
        t.apply(&Event::ItemDelta {
            item_id: "i1".into(),
            text: "llo".into(),
        });
        assert_eq!(t.get("i1"), Some(&text("i1", "Hello")));
        t.apply(&Event::ItemCompleted {
            item: text("i1", "Hello!"),
        });
        assert_eq!(t.items(), vec![text("i1", "Hello!")]);
    }

    #[test]
    fn a_completed_item_never_seen_is_added() {
        let mut t = Transcript::default();
        t.apply(&Event::ItemCompleted {
            item: text("i1", "x"),
        });
        assert_eq!(t.items().len(), 1);
    }

    #[test]
    fn the_oldest_items_go_past_the_cap_and_reset_clears() {
        let mut t = Transcript::default();
        for n in 0..=MAX_ITEMS {
            t.apply(&Event::ItemCompleted {
                item: text(&format!("i{n}"), ""),
            });
        }
        assert_eq!(t.items().len(), MAX_ITEMS);
        assert!(t.get("i0").is_none());
        t.apply(&Event::Reset);
        assert!(t.items().is_empty());
    }

    #[test]
    fn the_oldest_items_go_past_the_byte_budget_and_the_newest_stays() {
        let mut t = Transcript::default();
        let big = "x".repeat(MAX_BYTES / 4);
        for n in 0..6 {
            t.apply(&Event::ItemCompleted {
                item: text(&format!("i{n}"), &big),
            });
        }
        let kept = t.items();
        assert!(kept.len() < 6 && kept.len() >= 3, "{}", kept.len());
        assert!(t.get("i0").is_none());
        assert!(t.get("i5").is_some());
        // Growing the newest by deltas trims the older ones, not itself.
        for _ in 0..8 {
            t.apply(&Event::ItemDelta {
                item_id: "i5".into(),
                text: big.clone(),
            });
        }
        assert_eq!(t.items().len(), 1);
        t.apply(&Event::Reset);
        t.apply(&Event::ItemCompleted {
            item: text("i9", "small"),
        });
        assert_eq!(t.items().len(), 1);
    }
}
