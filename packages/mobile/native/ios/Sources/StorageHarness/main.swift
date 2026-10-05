import Foundation
import DocBlocksStorage
let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let storage = try Storage(roots: ["local": root])
while let line = readLine() {
    do {
        let request = try JSONSerialization.jsonObject(with: Data(line.utf8))
        let result = storage.request(request)
        let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
        print(String(decoding: data, as: UTF8.self)); fflush(stdout)
    } catch { fputs("Invalid harness input\n", stderr); exit(1) }
}
storage.shutdown()
