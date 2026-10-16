// Code Room for iPhone: the same room as the Mac app (index.html + sound.js, bundled under www/),
// in a full-screen web view. There is no Python on the phone, so the page scans repositories itself
// (scanner.js); this shell gives it what a page can't reach on its own: folders from the Files app,
// the scene classics from The Mod Archive, and sound that plays with the ringer switch on silent.
import AVFoundation
import SwiftUI

@main
struct CodeRoomApp: App {
    init() {
        // .playback: the room is music, so it keeps playing with the silent switch on (mixing with
        // whatever else is playing rather than stopping it)
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [.mixWithOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
    }

    var body: some Scene {
        WindowGroup {
            RoomView()
                .ignoresSafeArea()                       // the page lays itself out around the notch (env(safe-area-inset-*))
                .background(Color(red: 0.016, green: 0.008, blue: 0.047))
                .preferredColorScheme(.dark)
        }
    }
}
