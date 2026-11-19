//! Acts on what happens to agent sessions. The session manager reports a `Lifecycle` while it may hold its own lock, so the
//! reports are queued here and handled on one thread of their own, where a handler may call back into the manager.
use crate::agent::Lifecycle;
use std::sync::mpsc::{Receiver, Sender, channel};

/// One part of Hivemind that reacts to sessions. Called on the conductor thread, one report at a time.
pub type Handler = Box<dyn Fn(&Lifecycle) + Send>;

/// The queue the session manager's sink writes to, and the end the conductor thread reads.
pub fn queue() -> (Sender<Lifecycle>, Receiver<Lifecycle>) {
    channel()
}

/// Hand every report to each handler in order, until every sender is gone.
pub fn run(reports: Receiver<Lifecycle>, handlers: Vec<Handler>) {
    std::thread::spawn(move || {
        for report in reports {
            for handler in &handlers {
                handler(&report);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn every_handler_sees_every_report_in_order() {
        let (tx, rx) = queue();
        let seen = Arc::new(Mutex::new(vec![]));
        let (first, second) = (seen.clone(), seen.clone());
        run(
            rx,
            vec![
                Box::new(move |report| first.lock().unwrap().push(format!("a:{report:?}"))),
                Box::new(move |report| second.lock().unwrap().push(format!("b:{report:?}"))),
            ],
        );
        tx.send(Lifecycle::Waiting { id: "1".into() }).unwrap();
        tx.send(Lifecycle::TurnEnded { id: "1".into(), ok: true }).unwrap();
        drop(tx);
        for _ in 0..200 {
            if seen.lock().unwrap().len() == 4 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 4);
        assert!(seen[0].starts_with("a:Waiting") && seen[1].starts_with("b:Waiting") && seen[2].starts_with("a:TurnEnded"));
    }
}
