import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        BundledEmbeddingModel.install()
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

/// The search-by-meaning model ships inside the app (`public/embedding-model`,
/// staged by scripts/stage-embedding-model.mjs). Gezel's knowledge plugin
/// installs only models it downloads, but it counts a model as installed when
/// its store folder holds the files and an `installed.json` record of their
/// digests. So at launch the bundled files are cloned into that folder (APFS
/// clones: instant, no extra space) and recorded, and search by meaning and
/// the knowledge catalogs' questions work offline from the first launch.
/// A model already recorded with the same files is left alone.
enum BundledEmbeddingModel {
    private struct Manifest: Decodable {
        struct File: Decodable {
            let name: String
            let sha256: String
            let size: Int64
        }
        let store: String
        let files: [File]
    }

    /// Gezel's knowledge store (`SpeechModelStore(folder: "gezel-knowledge/catalogs")`).
    private static let storeFolder = "gezel-knowledge/catalogs"

    static func install() {
        let manager = FileManager.default
        guard let source = Bundle.main.resourceURL?.appendingPathComponent("public/embedding-model", isDirectory: true),
              let data = try? Data(contentsOf: source.appendingPathComponent("manifest.json")),
              let manifest = try? JSONDecoder().decode(Manifest.self, from: data),
              manifest.store.range(of: "^[a-z0-9][a-z0-9._-]{0,63}$", options: .regularExpression) != nil,
              !manifest.files.isEmpty,
              manifest.files.allSatisfy({ !$0.name.contains("..") && !$0.name.hasPrefix("/") }) else { return }
        var root = manager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(storeFolder, isDirectory: true)
        let folder = root.appendingPathComponent(manifest.store, isDirectory: true)
        let marker = folder.appendingPathComponent("installed.json")
        let expected = Dictionary(uniqueKeysWithValues: manifest.files.map { ($0.name, $0.sha256) })
        if let record = try? Data(contentsOf: marker),
           let value = try? JSONSerialization.jsonObject(with: record) as? [String: Any],
           value["files"] as? [String: String] == expected,
           manifest.files.allSatisfy({ manager.fileExists(atPath: folder.appendingPathComponent($0.name).path) }) {
            return
        }
        do {
            try manager.createDirectory(at: folder, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? root.setResourceValues(values)
            try? manager.removeItem(at: marker)
            for file in manifest.files {
                let target = folder.appendingPathComponent(file.name)
                try manager.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                try? manager.removeItem(at: target)
                try manager.copyItem(at: source.appendingPathComponent(file.name), to: target)
                let size = try target.resourceValues(forKeys: [.fileSizeKey]).fileSize
                guard size.map(Int64.init) == file.size else { throw CocoaError(.fileReadCorruptFile) }
            }
            let record = try JSONSerialization.data(withJSONObject: ["files": expected])
            try record.write(to: marker, options: .atomic)
        } catch {
            // Not recorded, so the app offers the download instead.
            try? manager.removeItem(at: marker)
        }
    }
}
