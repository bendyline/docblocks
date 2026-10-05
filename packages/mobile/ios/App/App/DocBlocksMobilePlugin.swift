import Foundation
import UIKit
import Capacitor
import WebKit
import UniformTypeIdentifiers

@objc(DocBlocksMobilePlugin)
public class DocBlocksMobilePlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "DocBlocksMobilePlugin"
    public let jsName = "DocBlocksMobile"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "bootstrap", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openExternal", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeText", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exportFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takeOpenRequests", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forgetFolder", returnType: CAPPluginReturnPromise)
    ]
    private let queue = DispatchQueue(label: "com.bendyline.docblocks.storage")
    private let pending = DispatchSemaphore(value: 32)
    private func submit(_ call: CAPPluginCall, _ action: @escaping () -> Void) {
        guard pending.wait(timeout: .now()) == .success else { call.reject("Device storage is busy. Try again."); return }
        queue.async { defer { self.pending.signal() }; action() }
    }
    private var storage: Storage?
    private var exportStaging: ExportStaging?
    private var exportCall: CAPPluginCall?
    private var exportToken: String?
    private var registry: WorkspaceRegistry?
    private var folderCall: CAPPluginCall?
    private var startupError: Error?
    public override func load() {
        do {
            let documents = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            let root = documents.appendingPathComponent("Workspace", isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            storage = try Storage(roots: ["local": root])
            registry = try WorkspaceRegistry()
            for workspace in registry!.workspaces {
                if let url = workspace.url {
                    do { try storage?.register(workspace.id, root: url) }
                    catch { /* Preserve unavailable folder metadata; other workspaces remain usable. */ }
                }
            }
            let caches = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            exportStaging = try ExportStaging(root: caches.appendingPathComponent("DocBlocksExports", isDirectory: true))
        } catch { startupError = error }
    }
    deinit { storage?.shutdown() }
    @objc func bootstrap(_ call: CAPPluginCall) {
        guard call.options.isEmpty, storage != nil, startupError == nil else { call.reject("Device storage could not be opened."); return }
        call.resolve([
            "env": ["surface": "capacitor", "surfaceLabel": "iOS", "platform": "ios", "appVersion": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "2.6.2", "isDev": false],
            "workspaces": [["id": "local", "name": "On this device", "rootPath": "On this device / DocBlocks"]] + (registry?.workspaces.map { $0.info } ?? []),
            "folderPicker": true,
            "capabilities": Storage.capabilities
        ])
    }
    @objc func request(_ call: CAPPluginCall) {
        guard Set(call.options.keys) == ["request"], let input = call.getObject("request"), let storage else { call.reject("Invalid storage request."); return }
        submit(call) { call.resolve(storage.request(input)) }
    }
    @objc func openExternal(_ call: CAPPluginCall) {
        guard Set(call.options.keys) == ["url"], let value = call.getString("url"), value.utf16.count <= 8192,
              let url = URL(string: value), ["http", "https"].contains(url.scheme), url.host != nil, url.user == nil, url.password == nil,
              url.absoluteString == value, !value.contains("\\"), value.unicodeScalars.allSatisfy({ $0.value > 32 && $0.value != 127 }) else { call.reject("Invalid external URL."); return }
        DispatchQueue.main.async { UIApplication.shared.open(url) { opened in if opened { call.resolve() } else { call.reject("The link could not be opened.") } } }
    }
    @objc func pickFolder(_ call: CAPPluginCall) {
        guard call.options.isEmpty else { call.reject("Invalid folder request."); return }
        DispatchQueue.main.async {
            guard self.folderCall == nil, self.exportCall == nil, let controller = self.bridge?.viewController else { call.reject("Close the current picker first."); return }
            self.folderCall = call
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
            picker.delegate = self; controller.present(picker, animated: true)
        }
    }
    @objc func forgetFolder(_ call: CAPPluginCall) {
        guard Set(call.options.keys) == ["workspaceId"], let id = call.getString("workspaceId"), UUID(uuidString: id) != nil else { call.reject("The device workspace cannot be removed."); return }
        DispatchQueue.main.async {
            do { try self.registry?.remove(id); self.storage?.unregister(id); call.resolve() }
            catch { call.reject("The workspace could not be removed.", nil, error) }
        }
    }
    @objc func takeOpenRequests(_ call: CAPPluginCall) {
        guard call.options.isEmpty, let storage else { call.reject("Invalid import request."); return }
        DispatchQueue.main.async {
            let urls = IncomingDocuments.pending; IncomingDocuments.pending = []
            self.submit(call) {
                do {
                    var requests: [[String: Any]] = []
                    for url in urls {
                        let scope = url.startAccessingSecurityScopedResource(); defer { if scope { url.stopAccessingSecurityScopedResource() } }
                        let path = try storage.importDocument(url)
                        requests.append(["kind": "workspace-file", "workspaceId": "local", "path": "/" + path])
                    }
                    call.resolve(["requests": requests])
                } catch { call.reject("The document could not be imported. The original file was not changed.", nil, error) }
            }
        }
    }
    @objc func exportFile(_ call: CAPPluginCall) {
        guard Set(call.options.keys) == ["request"], let request = call.getObject("request") else { call.reject("Invalid export request."); return }
        DispatchQueue.main.async { self.performExport(call, request) }
    }
    private func performExport(_ call: CAPPluginCall, _ request: [String: Any]) {
        do {
            guard let staging = exportStaging, let op = request["op"] as? String else { throw StorageFailure("corrupt") }
            switch op {
            case "begin":
                guard Set(request.keys) == ["op", "filename", "byteLength"], let filename = request["filename"] as? String,
                      let size = request["byteLength"] as? NSNumber, CFGetTypeID(size) != CFBooleanGetTypeID(), size.doubleValue == Double(size.intValue) else { throw StorageFailure("corrupt") }
                call.resolve(["transferId": try staging.begin(filename: filename, size: size.intValue)])
            case "append":
                guard Set(request.keys) == ["op", "transferId", "offset", "data"], let id = request["transferId"] as? String, let offset = request["offset"] as? NSNumber,
                      CFGetTypeID(offset) != CFBooleanGetTypeID(), offset.doubleValue == Double(offset.intValue), let data = request["data"] as? String else { throw StorageFailure("corrupt") }
                try staging.append(id, offset: offset.intValue, base64: data); call.resolve()
            case "cancel":
                guard Set(request.keys) == ["op", "transferId"], let id = request["transferId"] as? String, id != exportToken else { throw StorageFailure("busy") }
                try staging.cancel(id); call.resolve()
            case "finish":
                guard Set(request.keys) == ["op", "transferId", "action"], let id = request["transferId"] as? String, let action = request["action"] as? String,
                      ["save", "share"].contains(action), exportCall == nil, folderCall == nil, let controller = bridge?.viewController else { throw StorageFailure("busy") }
                let url = try staging.finish(id)
                exportCall = call; exportToken = id
                if action == "save" {
                    let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true); picker.delegate = self
                    controller.present(picker, animated: true)
                } else {
                    let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
                    sheet.popoverPresentationController?.sourceView = controller.view
                    sheet.popoverPresentationController?.sourceRect = CGRect(x: controller.view.bounds.midX, y: controller.view.bounds.midY, width: 1, height: 1)
                    sheet.completionWithItemsHandler = { _, completed, _, error in
                        if let error { self.exportCall?.reject("Sharing failed.", nil, error); self.exportCall = nil; self.exportToken = nil }
                        else { self.finishExport(completed ? "shared" : "cancelled") }
                    }
                    controller.present(sheet, animated: true)
                }
            default: throw StorageFailure("corrupt")
            }
        } catch { call.reject("The export could not be completed.", nil, error) }
    }
    private func finishExport(_ outcome: String) {
        let call = exportCall; exportCall = nil; exportToken = nil
        call?.resolve(["outcome": outcome])
    }
    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        if let call = folderCall { folderCall = nil; call.resolve(["workspace": NSNull()]) }
        else { finishExport("cancelled") }
    }
    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        if let call = folderCall {
            folderCall = nil
            do {
                guard let url = urls.first, let registry else { throw StorageFailure("permission-denied") }
                let workspace = try registry.add(url); try storage?.register(workspace.id, root: url)
                call.resolve(["workspace": workspace.info])
            } catch { call.reject("The folder could not be opened.", nil, error) }
        } else { finishExport(urls.isEmpty ? "cancelled" : "saved") }
    }
    @objc func writeText(_ call: CAPPluginCall) {
        guard Set(call.options.keys) == ["text"], let text = call.getString("text"), text.utf16.count <= 20 * 1024 * 1024 else { call.reject("Invalid clipboard text."); return }
        DispatchQueue.main.async { UIPasteboard.general.string = text; call.resolve() }
    }
}

class DocBlocksViewController: CAPBridgeViewController {
    private var boundary: PackagedEditorBoundary?
    override func capacitorDidLoad() {
        guard let implementation = bridge as? CapacitorBridge else { return }
        let original = implementation.webViewDelegationHandler
        let boundary = PackagedEditorBoundary(original: original)
        self.boundary = boundary
        original.contentController.removeScriptMessageHandler(forName: "bridge")
        original.contentController.add(boundary, name: "bridge")
        webView?.navigationDelegate = boundary
        bridge?.registerPluginInstance(DocBlocksMobilePlugin())
    }
}

private final class PackagedEditorBoundary: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    let original: WebViewDelegationHandler
    init(original: WebViewDelegationHandler) { self.original = original }
    private func packaged(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.scheme == "capacitor" && url.host == "localhost" && url.port == nil && ["", "/", "/index.html"].contains(url.path)
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == "capacitor", message.frameInfo.securityOrigin.host == "localhost", packaged(message.frameInfo.request.url) else { return }
        guard let body = message.body as? [String: Any], ["message", "js.error"].contains(body["type"] as? String ?? "") else { return }
        original.userContentController(controller, didReceive: message)
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.targetFrame?.isMainFrame != false { decisionHandler(packaged(action.request.url) ? .allow : .cancel) }
        else { decisionHandler(["about", "blob"].contains(action.request.url?.scheme ?? "") ? .allow : .cancel) }
    }
    override func responds(to selector: Selector!) -> Bool { super.responds(to: selector) || original.responds(to: selector) }
    override func forwardingTarget(for selector: Selector!) -> Any? { original.responds(to: selector) ? original : super.forwardingTarget(for: selector) }
}

enum IncomingDocuments {
    static var pending: [URL] = []
    static func receive(_ urls: [URL]) {
        for url in urls where pending.count < 8 && url.isFileURL && ["md", "markdown"].contains(url.pathExtension.lowercased()) { pending.append(url) }
    }
}
