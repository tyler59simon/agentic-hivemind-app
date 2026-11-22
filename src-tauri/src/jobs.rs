//! A Windows Job Object that ends every process in it when it is closed or ended, so stopping a process also stops what
//! it started (PROC-3, LM-1). Elsewhere it does nothing: a child there is stopped through its own handle.
use std::process::Child;

#[cfg(windows)]
pub struct Job(windows_sys::Win32::Foundation::HANDLE);

// The handle is only used through the kernel calls below, which are safe to make from any thread.
#[cfg(windows)]
unsafe impl Send for Job {}
#[cfg(windows)]
unsafe impl Sync for Job {}

#[cfg(windows)]
impl Job {
    /// A new job that kills its processes when its last handle closes, or None when the system refuses one.
    pub fn new() -> Option<Job> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        // SAFETY: plain kernel calls; the information block is zeroed and fully owned by this frame.
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if set == 0 {
                CloseHandle(handle);
                return None;
            }
            Some(Job(handle))
        }
    }

    /// Put `child` (and from now on everything it starts) in the job. False when the system refuses.
    pub fn add(&self, child: &Child) -> bool {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        // SAFETY: both handles are open for the duration of the call.
        unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle()) != 0 }
    }

    /// End every process in the job now.
    pub fn end(&self) {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        // SAFETY: the handle is open until `drop`.
        unsafe {
            TerminateJobObject(self.0, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: the handle is closed once, here. Closing it kills what is still in the job.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(not(windows))]
pub struct Job;

#[cfg(not(windows))]
impl Job {
    pub fn new() -> Option<Job> {
        Some(Job)
    }

    pub fn add(&self, _child: &Child) -> bool {
        true
    }

    pub fn end(&self) {}
}

/// Whether a process with this id is running, for tests that check a stopped process is gone.
#[cfg(test)]
pub fn alive(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let Ok(mut system) = System::new() else { return false };
    let pid = Pid::from_u32(pid);
    system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    system.process(pid).is_some()
}
