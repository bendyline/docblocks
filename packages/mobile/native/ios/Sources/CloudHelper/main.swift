import Foundation
import DocBlocksStorage

// The Mac app's iCloud helper: one JSON request per line in, one JSON reply per line out.
// It ends when its input closes, so it never outlives the app that started it.
let service = CloudHelperService()
setvbuf(stdout, nil, _IOLBF, 0)
while let line = readLine(strippingNewline: true) {
    guard line.utf8.count <= 1_048_576 else { fputs("Request too large\n", stderr); exit(2) }
    let request = try? JSONSerialization.jsonObject(with: Data(line.utf8))
    let reply = service.handle(request as Any)
    guard let data = try? JSONSerialization.data(withJSONObject: reply, options: [.sortedKeys]) else { exit(3) }
    print(String(decoding: data, as: UTF8.self))
}
