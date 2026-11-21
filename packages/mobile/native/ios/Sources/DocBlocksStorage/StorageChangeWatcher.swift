import Foundation

/// Turns a stream of "something changed" moments into at most one report per interval, with the
/// last moment of a burst always reported. iCloud delivers a document as several metadata updates.
public final class ChangeThrottle {
    private let interval: TimeInterval
    private let queue: DispatchQueue
    private let report: () -> Void
    private var lastReport = Date.distantPast
    private var scheduled = false
    private var stopped = false
    public init(interval: TimeInterval, queue: DispatchQueue = .main, report: @escaping () -> Void) {
        self.interval = interval; self.queue = queue; self.report = report
    }
    /// Safe from any thread.
    public func note() {
        queue.async {
            guard !self.stopped, !self.scheduled else { return }
            let wait = self.lastReport.addingTimeInterval(self.interval).timeIntervalSinceNow
            guard wait > 0 else { self.fire(); return }
            self.scheduled = true
            self.queue.asyncAfter(deadline: .now() + wait) {
                self.scheduled = false
                if !self.stopped { self.fire() }
            }
        }
    }
    public func stop() { queue.async { self.stopped = true } }
    public func start() { queue.async { self.stopped = false } }
    private func fire() { lastReport = Date(); report() }
}

/// Watches the app's iCloud Drive documents and says when they may have changed, without saying
/// which. The page then re-checks what it shows, exactly as it does when the app comes back.
///
/// This only observes. It takes no part in file coordination and never touches the storage lock,
/// so it cannot delay a read, a save, or another app's access to the same files.
public final class StorageChangeWatcher {
    private let throttle: ChangeThrottle
    private var query: NSMetadataQuery?
    private var observers: [NSObjectProtocol] = []
    private var wanted = false
    /// `onChange` runs on the main queue, at most once per `interval`.
    public init(interval: TimeInterval = 1, onChange: @escaping () -> Void) {
        throttle = ChangeThrottle(interval: interval, report: onChange)
    }
    deinit { observers.forEach(NotificationCenter.default.removeObserver); query?.stop() }

    /// Start following the app's iCloud documents. Call on the main thread.
    public func watchCloudDocuments() {
        wanted = true
        startQuery()
    }
    /// The app left the screen: a live query would only spend battery on updates nobody sees.
    public func suspend() {
        throttle.stop()
        stopQuery()
    }
    /// The app is back. Anything may have changed while it was away, so say so once.
    public func resume() {
        throttle.start()
        if wanted { startQuery() }
        throttle.note()
    }

    private func startQuery() {
        guard query == nil else { return }
        let query = NSMetadataQuery()
        query.searchScopes = [NSMetadataQueryUbiquitousDocumentsScope]
        query.predicate = NSPredicate(format: "%K LIKE '*'", NSMetadataItemFSNameKey)
        query.notificationBatchingInterval = 0.5
        let center = NotificationCenter.default
        // The first gathering lists what is already there; only later updates are news.
        observers = [.NSMetadataQueryDidUpdate].map { name in
            center.addObserver(forName: name, object: query, queue: .main) { [weak self] _ in self?.throttle.note() }
        }
        self.query = query
        query.start()
    }
    private func stopQuery() {
        observers.forEach(NotificationCenter.default.removeObserver); observers = []
        query?.stop(); query = nil
    }
}
