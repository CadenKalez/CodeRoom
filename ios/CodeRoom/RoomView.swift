import SwiftUI
import UniformTypeIdentifiers
import WebKit

/// The room: a WKWebView showing coderoom://app/index.html, served from the app bundle by `RoomScheme`.
struct RoomView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> RoomController { RoomController() }
    func updateUIViewController(_ controller: RoomController, context: Context) {}
}

final class RoomController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate, UIDocumentPickerDelegate {
    private var webView: WKWebView!
    private let scheme = RoomScheme()

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(scheme, forURLScheme: RoomScheme.name)
        config.mediaTypesRequiringUserActionForPlayback = []      // the ambience may start without a tap
        config.allowsInlineMediaPlayback = true
        let content = config.userContentController
        // tells the page it's in the iPhone app: no server, it scans repositories itself
        content.addUserScript(WKUserScript(source: "window.CODEROOM_IOS = true;", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        content.add(WeakHandler(self), name: "codeRoom")

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.016, green: 0.008, blue: 0.047, alpha: 1)
        webView.scrollView.isScrollEnabled = false               // the page is a fixed scene, not a document
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsLinkPreview = false
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }   // Safari › Develop for debugging
        #endif
        view = webView
        webView.load(URLRequest(url: URL(string: "\(RoomScheme.name)://app/index.html")!))
    }

    override var prefersStatusBarHidden: Bool { false }
    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    // MARK: messages from the page (window.webkit.messageHandlers.codeRoom)

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "pickFolder": pickFolder()
        default: break                                            // openFile / reveal are for the Mac
        }
    }

    private func pickFolder() {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
        picker.delegate = self
        picker.allowsMultipleSelection = false
        present(picker, animated: true)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let url = urls.first, let id = RepoStore.shared.remember(folder: url) else { return }
        let root = "files:\(id)|\(url.lastPathComponent)"
        let arg = String(data: try! JSONSerialization.data(withJSONObject: [root], options: []), encoding: .utf8)!
        webView.evaluateJavaScript("window.codeRoomOpen && window.codeRoomOpen(\(arg)[0])")
    }

    // links the page might open (e.g. a module's source on GitHub) go to Safari, the room stays
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, url.scheme != RoomScheme.name, action.navigationType == .linkActivated {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    // if the web content process is killed (memory pressure), bring the room back
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }
}

/// WKUserContentController keeps its handlers strongly; this breaks the cycle with the controller.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { target?.userContentController(c, didReceive: m) }
}
