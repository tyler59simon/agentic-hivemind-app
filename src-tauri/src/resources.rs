//! CPU and memory of the agent programs Hivemind started, each with the processes it started in turn, sampled every few
//! seconds while any runs and sent to the page as `agent-resources`.
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

const EVERY: Duration = Duration::from_secs(5);

/// One session's processes, summed.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    /// Percent of the whole machine (all cores), 0 to 100.
    pub cpu: f32,
    pub memory_mb: f64,
    pub processes: usize,
}

/// One process as sampled: its id, its parent's, its CPU in percent of one core, its memory in bytes.
pub type Sample = (u32, Option<u32>, f32, u64);

/// The usage of `root` and every process below it. `cores` turns per-core percent into percent of the machine.
pub fn tree(root: u32, samples: &[Sample], cores: usize) -> Option<Usage> {
    let mut children: HashMap<u32, Vec<&Sample>> = HashMap::new();
    for sample in samples {
        if let Some(parent) = sample.1 {
            children.entry(parent).or_default().push(sample);
        }
    }
    let first = samples.iter().find(|sample| sample.0 == root)?;
    let (mut usage, mut seen, mut queue) = (Usage::default(), HashSet::new(), vec![first]);
    while let Some(&(pid, _, cpu, memory)) = queue.pop() {
        // A pid reused by a process that names a descendant as its parent would loop forever without this.
        if !seen.insert(pid) {
            continue;
        }
        usage.cpu += cpu;
        usage.memory_mb += memory as f64 / (1024.0 * 1024.0);
        usage.processes += 1;
        queue.extend(children.get(&pid).into_iter().flatten());
    }
    usage.cpu = (usage.cpu / cores.max(1) as f32).min(100.0);
    Some(usage)
}

/// Sample forever: `roots` gives the session id and program pid of everything running, `send` receives each sample. Nothing
/// is sent while nothing runs, except one empty map when the last program has gone.
pub fn watch(roots: impl Fn() -> Vec<(String, u32)> + Send + 'static, send: impl Fn(HashMap<String, Usage>) + Send + 'static) {
    std::thread::spawn(move || {
        // A system sysinfo cannot read gets no samples; nothing else depends on them.
        let Ok(mut system) = System::new() else { return };
        let cores = std::thread::available_parallelism().map_or(1, |n| n.get());
        let mut was_running = false;
        loop {
            std::thread::sleep(EVERY);
            let roots = roots();
            if roots.is_empty() {
                if std::mem::take(&mut was_running) {
                    send(HashMap::new());
                }
                continue;
            }
            was_running = true;
            system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_cpu().with_memory());
            let samples: Vec<Sample> = system
                .processes()
                .iter()
                .map(|(pid, process)| (pid.as_u32(), process.parent().map(|parent| parent.as_u32()), process.cpu_usage(), process.memory()))
                .collect();
            send(roots.into_iter().filter_map(|(id, pid)| Some((id, tree(pid, &samples, cores)?))).collect());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tree_sums_the_program_and_everything_below_it() {
        const MB: u64 = 1024 * 1024;
        let samples = [(10, Some(1), 50.0, 100 * MB), (11, Some(10), 30.0, 50 * MB), (12, Some(11), 20.0, 10 * MB), (20, Some(1), 90.0, 999 * MB)];
        let usage = tree(10, &samples, 2).unwrap();
        assert_eq!((usage.cpu, usage.memory_mb, usage.processes), (50.0, 160.0, 3));
        assert_eq!(tree(99, &samples, 2), None);
        assert_eq!(tree(20, &samples, 0).unwrap().cpu, 90.0);
        assert_eq!(tree(10, &[(10, Some(11), 400.0, MB), (11, Some(10), 400.0, MB)], 1).unwrap().cpu, 100.0, "capped, and a cycle ends");
    }
}
