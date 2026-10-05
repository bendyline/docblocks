// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "DocBlocksStorage",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [.library(name: "DocBlocksStorage", targets: ["DocBlocksStorage"]), .executable(name: "StorageHarness", targets: ["StorageHarness"])],
    targets: [.target(name: "DocBlocksStorage"), .executableTarget(name: "StorageHarness", dependencies: ["DocBlocksStorage"]), .testTarget(name: "DocBlocksStorageTests", dependencies: ["DocBlocksStorage"])])
