//! Bridges AppKit's application-level Quit lifecycle to the shared editor guard.
//!
//! Tauri currently does not surface `applicationShouldTerminate:` on macOS
//! (https://github.com/tauri-apps/tauri/issues/9198). Keep this small subclass
//! isolated so it can be removed when upstream exposes an equivalent hook.

use std::{
    ffi::c_char,
    sync::{Mutex, OnceLock},
};

use objc2::{
    runtime::{AnyClass, AnyObject, ClassBuilder, Sel},
    sel, MainThreadMarker,
};
use objc2_app_kit::{NSApplication, NSApplicationTerminateReply};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

const DELEGATE_SUBCLASS_NAME: &[u8] = b"FsnTaoAppDelegate\0";
const QUIT_EVENT: &str = "fsn://quit-requested";
/// How long a `Pending` request waits for the webview to answer before the
/// watchdog force-replies `false`. Long enough that a user staring at an
/// unsaved-changes confirm dialog isn't rushed; short enough that a dead or
/// stuck webview can't hold Cmd-Q (or logout) hostage indefinitely. If the
/// unsaved-changes confirm ever becomes asynchronous, revisit this constant.
const QUIT_WATCHDOG: std::time::Duration = std::time::Duration::from_secs(30);

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
static QUIT_BRIDGE: Mutex<QuitBridge> = Mutex::new(QuitBridge::new());

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BridgeState {
    Unready,
    Ready,
    Pending(u64),
    Responding(u64),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QuitDecision {
    Cancel,
    Wait,
    Emit(u64),
}

/// Result of `QuitBridge::mark_ready`, distinguishing the normal case from a
/// reload that re-arms the bridge out from under an in-flight request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MarkReadyOutcome {
    /// Bridge was `Unready` or already `Ready`; it is now `Ready`.
    Ready,
    /// A `Pending` request was still waiting on the webview that just
    /// reloaded. State is forced to `Ready`; the caller owes that request a
    /// `false` reply since nothing else will ever answer it.
    RearmedPending(u64),
    /// A response was in flight (`Responding`) when the webview reloaded.
    /// State is forced to `Ready`, but no reply is sent here: the
    /// in-flight main-thread closure from `respond` already carries (or
    /// will carry) the reply, and replying again would double-reply.
    RearmedResponding(u64),
}

#[derive(Debug)]
struct QuitBridge {
    state: BridgeState,
    next_request_id: u64,
}

impl QuitBridge {
    const fn new() -> Self {
        Self {
            state: BridgeState::Unready,
            next_request_id: 1,
        }
    }

    fn mark_ready(&mut self) -> MarkReadyOutcome {
        match self.state {
            BridgeState::Unready | BridgeState::Ready => {
                self.state = BridgeState::Ready;
                MarkReadyOutcome::Ready
            }
            BridgeState::Pending(request_id) => {
                self.state = BridgeState::Ready;
                MarkReadyOutcome::RearmedPending(request_id)
            }
            BridgeState::Responding(request_id) => {
                self.state = BridgeState::Ready;
                MarkReadyOutcome::RearmedResponding(request_id)
            }
        }
    }

    fn request(&mut self) -> QuitDecision {
        match self.state {
            BridgeState::Unready => QuitDecision::Cancel,
            BridgeState::Ready => {
                let request_id = self.next_request_id;
                self.next_request_id = self.next_request_id.saturating_add(1);
                self.state = BridgeState::Pending(request_id);
                QuitDecision::Emit(request_id)
            }
            BridgeState::Pending(_) | BridgeState::Responding(_) => QuitDecision::Wait,
        }
    }

    fn cancel_emit(&mut self, request_id: u64) {
        if self.state == BridgeState::Pending(request_id) {
            self.state = BridgeState::Ready;
        }
    }

    fn accept_response(&mut self, request_id: u64) -> Result<(), String> {
        if self.state != BridgeState::Pending(request_id) {
            return Err("This macOS quit response is stale".into());
        }
        self.state = BridgeState::Responding(request_id);
        Ok(())
    }

    fn finish_response(&mut self, request_id: u64) {
        if self.state == BridgeState::Responding(request_id) {
            self.state = BridgeState::Ready;
        }
    }

    /// Watchdog timeout: force a still-`Pending` request back to `Ready` so
    /// it can be answered `false` on the caller's behalf. Returns `false`
    /// (no-op) if the request already moved on — it was answered, went
    /// stale, or is a different id — including while `Responding`, where a
    /// second reply would race the one already in flight.
    fn expire(&mut self, request_id: u64) -> bool {
        if self.state == BridgeState::Pending(request_id) {
            self.state = BridgeState::Ready;
            true
        } else {
            false
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QuitRequest {
    request_id: u64,
}

pub fn install(app: &AppHandle) -> Result<(), String> {
    APP_HANDLE
        .set(app.clone())
        .map_err(|_| "The macOS quit bridge was installed more than once".to_string())?;

    let mtm = MainThreadMarker::new()
        .ok_or_else(|| "The macOS quit bridge must be installed on the main thread".to_string())?;
    let application = NSApplication::sharedApplication(mtm);
    let delegate = application
        .delegate()
        .ok_or_else(|| "The macOS application delegate is unavailable".to_string())?;
    let delegate: &AnyObject = delegate.as_ref();
    let current_class = delegate.class();

    let name =
        unsafe { std::ffi::CStr::from_ptr(DELEGATE_SUBCLASS_NAME.as_ptr().cast::<c_char>()) };
    let subclass = if let Some(existing) = AnyClass::get(name) {
        existing
    } else {
        let mut builder = ClassBuilder::new(name, current_class)
            .ok_or_else(|| "The macOS quit delegate subclass could not be created".to_string())?;
        unsafe {
            builder.add_method::<AnyObject, _>(
                sel!(applicationShouldTerminate:),
                application_should_terminate as extern "C-unwind" fn(_, _, _) -> _,
            );
        }
        builder.register()
    };

    let previous = unsafe { AnyObject::set_class(delegate, subclass) };
    if !std::ptr::eq(previous, current_class) {
        // A half-installed bridge must not survive its own failure report:
        // undo our swap so the delegate is left exactly as we found it,
        // rather than quit being permanently wedged to Cancel.
        unsafe { AnyObject::set_class(delegate, previous) };
        return Err("The macOS application delegate changed during quit-bridge setup".into());
    }
    Ok(())
}

/// Replies `false` to AppKit on the main thread, mirroring `respond`'s reply
/// path. Used whenever a `Pending` request needs to be force-answered
/// because the webview that owed the answer will never do so: the watchdog
/// timeout, or a reload that dropped the pending request.
fn reply_false_on_main_thread() {
    let Some(app) = APP_HANDLE.get() else {
        return;
    };
    let app = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(mtm) = MainThreadMarker::new() {
            NSApplication::sharedApplication(mtm).replyToApplicationShouldTerminate(false);
        }
    });
}

/// Watchdog callback: 30 s after a request was emitted, force it to answer
/// `false` if it is still `Pending`. Long enough for a user staring at an
/// unsaved-changes confirm; short enough that a dead webview can't hold
/// Cmd-Q hostage. A response that arrives after this runs is already
/// rejected as stale by `accept_response`.
fn expire_pending(request_id: u64) {
    let expired = QUIT_BRIDGE
        .lock()
        .map(|mut bridge| bridge.expire(request_id))
        .unwrap_or(false);
    if expired {
        reply_false_on_main_thread();
    }
}

pub fn mark_ready() -> Result<(), String> {
    let outcome = QUIT_BRIDGE
        .lock()
        .map_err(|_| "The macOS quit bridge is unavailable".to_string())?
        .mark_ready();

    // A reload while a request was Pending means the webview that owed the
    // answer is gone; answer `false` on its behalf so quit doesn't wedge.
    // While Responding, `respond`'s in-flight main-thread closure already
    // carries (or will carry) the reply, so replying again here would
    // double-reply the same sequence — leave the forced-Ready state alone.
    if let MarkReadyOutcome::RearmedPending(_request_id) = outcome {
        reply_false_on_main_thread();
    }
    Ok(())
}

pub fn respond(app: AppHandle, request_id: u64, confirmed: bool) -> Result<(), String> {
    QUIT_BRIDGE
        .lock()
        .map_err(|_| "The macOS quit bridge is unavailable".to_string())?
        .accept_response(request_id)?;

    if let Err(error) = app.run_on_main_thread(move || {
        if let Ok(mut bridge) = QUIT_BRIDGE.lock() {
            bridge.finish_response(request_id);
        }
        if let Some(mtm) = MainThreadMarker::new() {
            NSApplication::sharedApplication(mtm).replyToApplicationShouldTerminate(confirmed);
        }
    }) {
        if let Ok(mut bridge) = QUIT_BRIDGE.lock() {
            bridge.finish_response(request_id);
        }
        return Err(format!(
            "The macOS quit response could not be delivered: {error}"
        ));
    }
    Ok(())
}

extern "C-unwind" fn application_should_terminate(
    _delegate: &AnyObject,
    _selector: Sel,
    _application: &NSApplication,
) -> NSApplicationTerminateReply {
    let decision = QUIT_BRIDGE
        .lock()
        .map(|mut bridge| bridge.request())
        .unwrap_or(QuitDecision::Cancel);

    match decision {
        QuitDecision::Cancel => NSApplicationTerminateReply::TerminateCancel,
        QuitDecision::Wait => NSApplicationTerminateReply::TerminateLater,
        QuitDecision::Emit(request_id) => {
            let emitted = APP_HANDLE.get().is_some_and(|app| {
                app.emit_to("main", QUIT_EVENT, QuitRequest { request_id })
                    .is_ok()
            });
            if emitted {
                std::thread::spawn(move || {
                    std::thread::sleep(QUIT_WATCHDOG);
                    expire_pending(request_id);
                });
                NSApplicationTerminateReply::TerminateLater
            } else {
                if let Ok(mut bridge) = QUIT_BRIDGE.lock() {
                    bridge.cancel_emit(request_id);
                }
                NSApplicationTerminateReply::TerminateCancel
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_fails_closed_until_ready() {
        let mut bridge = QuitBridge::new();
        assert_eq!(bridge.request(), QuitDecision::Cancel);
    }

    #[test]
    fn bridge_accepts_only_the_matching_pending_response() {
        let mut bridge = QuitBridge::new();
        assert_eq!(bridge.mark_ready(), MarkReadyOutcome::Ready);
        let QuitDecision::Emit(request_id) = bridge.request() else {
            panic!("expected quit event");
        };
        assert_eq!(bridge.request(), QuitDecision::Wait);
        assert!(bridge.accept_response(request_id + 1).is_err());
        bridge.accept_response(request_id).unwrap();
        bridge.finish_response(request_id);
        assert!(matches!(bridge.request(), QuitDecision::Emit(_)));
    }

    #[test]
    fn expire_on_matching_pending_resets_to_ready_and_can_emit_again() {
        let mut bridge = QuitBridge::new();
        assert_eq!(bridge.mark_ready(), MarkReadyOutcome::Ready);
        let QuitDecision::Emit(request_id) = bridge.request() else {
            panic!("expected quit event");
        };

        assert!(bridge.expire(request_id));

        assert!(matches!(bridge.request(), QuitDecision::Emit(_)));
    }

    #[test]
    fn expire_with_stale_id_or_while_responding_is_a_no_op() {
        let mut bridge = QuitBridge::new();
        assert_eq!(bridge.mark_ready(), MarkReadyOutcome::Ready);
        let QuitDecision::Emit(request_id) = bridge.request() else {
            panic!("expected quit event");
        };

        // Stale id: does not match the current Pending request.
        assert!(!bridge.expire(request_id + 1));
        assert_eq!(bridge.request(), QuitDecision::Wait);

        // Responding: the request has moved past Pending.
        bridge.accept_response(request_id).unwrap();
        assert!(!bridge.expire(request_id));
        assert_eq!(bridge.request(), QuitDecision::Wait);
    }

    #[test]
    fn mark_ready_while_pending_rearms_and_reports_the_cancelled_id() {
        let mut bridge = QuitBridge::new();
        assert_eq!(bridge.mark_ready(), MarkReadyOutcome::Ready);
        let QuitDecision::Emit(request_id) = bridge.request() else {
            panic!("expected quit event");
        };

        assert_eq!(
            bridge.mark_ready(),
            MarkReadyOutcome::RearmedPending(request_id)
        );

        assert!(matches!(bridge.request(), QuitDecision::Emit(_)));
    }

    #[test]
    fn mark_ready_while_responding_rearms_without_reporting_an_id_to_reply_to() {
        let mut bridge = QuitBridge::new();
        assert_eq!(bridge.mark_ready(), MarkReadyOutcome::Ready);
        let QuitDecision::Emit(request_id) = bridge.request() else {
            panic!("expected quit event");
        };
        bridge.accept_response(request_id).unwrap();

        assert_eq!(
            bridge.mark_ready(),
            MarkReadyOutcome::RearmedResponding(request_id)
        );

        assert!(matches!(bridge.request(), QuitDecision::Emit(_)));
    }

    #[test]
    fn a_late_response_after_expiry_is_rejected_as_stale() {
        let mut bridge = QuitBridge::new();
        assert_eq!(bridge.mark_ready(), MarkReadyOutcome::Ready);
        let QuitDecision::Emit(request_id) = bridge.request() else {
            panic!("expected quit event");
        };

        assert!(bridge.expire(request_id));

        assert!(bridge.accept_response(request_id).is_err());
    }
}
