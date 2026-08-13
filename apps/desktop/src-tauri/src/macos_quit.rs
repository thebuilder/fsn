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

    fn mark_ready(&mut self) -> Result<(), String> {
        match self.state {
            BridgeState::Unready | BridgeState::Ready => {
                self.state = BridgeState::Ready;
                Ok(())
            }
            BridgeState::Pending(_) | BridgeState::Responding(_) => {
                Err("A macOS quit request is already pending".into())
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
        return Err("The macOS application delegate changed during quit-bridge setup".into());
    }
    Ok(())
}

pub fn mark_ready() -> Result<(), String> {
    QUIT_BRIDGE
        .lock()
        .map_err(|_| "The macOS quit bridge is unavailable".to_string())?
        .mark_ready()
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
        bridge.mark_ready().unwrap();
        let QuitDecision::Emit(request_id) = bridge.request() else {
            panic!("expected quit event");
        };
        assert_eq!(bridge.request(), QuitDecision::Wait);
        assert!(bridge.accept_response(request_id + 1).is_err());
        bridge.accept_response(request_id).unwrap();
        bridge.finish_response(request_id);
        assert!(matches!(bridge.request(), QuitDecision::Emit(_)));
    }
}
