import Foundation

/// How current the local copy of an iCloud item is.
public enum CloudFreshness { case notDownloaded, stale, current }

/// What iCloud reports about items in a synced root. A seam: tests stand in for a signed-in device.
public protocol CloudState {
    /// Nil when iCloud does not manage the item.
    func freshness(of url: URL) -> CloudFreshness?
    /// True when the last download attempt failed, for example while offline.
    func downloadFailed(for url: URL) -> Bool
    func startDownloading(_ url: URL) throws
    /// How far the item's upload has got. Nil for an item iCloud does not sync.
    func upload(of url: URL) -> CloudUpload?
}
public extension CloudState {
    func upload(of url: URL) -> CloudUpload? { nil }
}

/// Whether an item's latest content has reached iCloud.
public struct CloudUpload: Equatable {
    public var uploaded: Bool
    public var uploading: Bool
    public init(uploaded: Bool, uploading: Bool) { self.uploaded = uploaded; self.uploading = uploading }
}

public struct SystemCloudState: CloudState {
    public init() {}
    public func freshness(of url: URL) -> CloudFreshness? {
        // A new URL each time: resource values are cached per instance.
        guard let status = (try? URL(fileURLWithPath: url.path).resourceValues(forKeys: [.ubiquitousItemDownloadingStatusKey]))?.ubiquitousItemDownloadingStatus else { return nil }
        if status == .notDownloaded { return .notDownloaded }
        // "Downloaded" means a local copy exists but iCloud holds a newer one.
        if status == .downloaded { return .stale }
        return status == .current ? .current : nil
    }
    public func downloadFailed(for url: URL) -> Bool {
        (try? URL(fileURLWithPath: url.path).resourceValues(forKeys: [.ubiquitousItemDownloadingErrorKey]))?.ubiquitousItemDownloadingError != nil
    }
    public func startDownloading(_ url: URL) throws { try FileManager.default.startDownloadingUbiquitousItem(at: url) }
    public func upload(of url: URL) -> CloudUpload? {
        guard let values = try? URL(fileURLWithPath: url.path).resourceValues(forKeys: [.isUbiquitousItemKey, .ubiquitousItemIsUploadedKey, .ubiquitousItemIsUploadingKey]), values.isUbiquitousItem == true else { return nil }
        return CloudUpload(uploaded: values.ubiquitousItemIsUploaded ?? false, uploading: values.ubiquitousItemIsUploading ?? false)
    }
}

/// How long storage waits on iCloud. Short, because every other request queues behind the wait.
public struct CloudWaits {
    public var notDownloaded: TimeInterval = 15
    public var staleRead: TimeInterval = 4
    public var staleChange: TimeInterval = 2
    /// After refusing to change a stale file for this long, the change goes ahead and iCloud keeps both versions.
    public var staleGrace: TimeInterval = 10
    public var poll: TimeInterval = 0.1
    public init() {}
}
