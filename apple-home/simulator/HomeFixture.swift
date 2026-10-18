import SwiftUI
import HomeKit
import LocalAuthentication
import ObjectiveC

#if !targetEnvironment(simulator)
#error("The Home fixture app must only run in an iOS Simulator")
#endif

@main
struct HomeFixtureApp: App {
    @StateObject private var model = HomeFixture()
    var body: some Scene {
        WindowGroup {
            VStack(alignment: .leading, spacing: 16) {
                Text("Apple Home Plugin QA").font(.title)
                Text("Local simulator fixtures. Leave this simulator signed out of iCloud.")
                Button("1. Load HomeKit", action: model.load)
                Button("2. Create Test Home", action: model.createHome)
                Button("3. Pair Mock Bridge", action: model.pair)
                Button("4. Create Rooms and Scenes", action: model.fixtures)
                Button("Discover QA Accessories", action: model.browse)
                Button("Pair Discovered QA Accessory", action: model.pairDiscovered)
                #if QA_PRIVATE_PAIRING
                Button("Pair QA Accessory with Fixture Code", action: model.pairWithCode)
                #endif
                Button("Verify Public HomeKit Control", action: model.verifyControl)
                Button("Create Disabled QA Automation", action: model.addAutomation)
                Button("Verify Device Authentication", action: model.authenticate)
                ScrollView { Text(model.log).font(.system(.caption, design: .monospaced)).frame(maxWidth: .infinity, alignment: .leading) }
            }.padding()
        }
    }
}

final class HomeFixture: NSObject, ObservableObject, HMHomeManagerDelegate, HMAccessoryBrowserDelegate {
    @Published var log = "Ready."
    private var manager: HMHomeManager?
    private let setupManager = HMAccessorySetupManager()
    private let browser = HMAccessoryBrowser()
    private let homeName = "CoreApp Simulator Home"
    private var authentication: LAContext?
    private func record(_ text: String) {
        DispatchQueue.main.async {
            self.log += "\n" + text
            print(text)
            try? self.log.write(to: FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("fixture.log"), atomically: true, encoding: .utf8)
        }
    }
    func load() {
        guard manager == nil else { record("HomeKit already loaded"); return }
        manager = HMHomeManager()
        manager?.delegate = self
        record("Loading HomeKit…")
    }
    func homeManagerDidUpdateHomes(_ manager: HMHomeManager) {
        record("Loaded \(manager.homes.count) homes; authorization=\(manager.authorizationStatus.rawValue)")
        for home in manager.homes { record("\(home.name): \(home.accessories.count) accessories") }
    }
    func homeManager(_ manager: HMHomeManager, didUpdate status: HMHomeManagerAuthorizationStatus) {
        record("Authorization: \(status.rawValue)")
    }
    private func testHome() -> HMHome? {
        guard let manager, manager.homes.allSatisfy({ $0.name == homeName }) else {
            record("Use a dedicated simulator with only the test home"); return nil
        }
        return manager.homes.first
    }
    func createHome() {
        guard let manager else { record("Load HomeKit first"); return }
        guard manager.homes.isEmpty else { record("Home already exists; no changes made"); return }
        manager.addHome(withName: homeName) { home, error in
            self.record(error.map { "Create home: \($0)" } ?? "Created \(home!.name)")
        }
    }
    func pair() {
        guard let home = testHome() else { record("Create the test home first"); return }
        let request = HMAccessorySetupRequest()
        request.homeUniqueIdentifier = home.uniqueIdentifier
        if let uri = Bundle.main.object(forInfoDictionaryKey: "FixtureSetupURI") as? String {
            request.payload = HMAccessorySetupPayload(url: URL(string: uri))
        }
        setupManager.performAccessorySetup(using: request) { _, error in
            self.record(error.map { "Pairing: \($0)" } ?? "Pairing complete")
        }
    }
    private func isFixtureAccessory(_ accessory: HMAccessory) -> Bool {
        accessory.name.hasPrefix("QA CoreApp Bridge") || accessory.name.hasPrefix("QA Television")
    }
    func browse() {
        browser.delegate = self
        browser.startSearchingForNewAccessories()
        record("Searching for QA accessories…")
    }
    func accessoryBrowser(_ browser: HMAccessoryBrowser, didFindNewAccessory accessory: HMAccessory) {
        guard isFixtureAccessory(accessory) else { return }
        record("Discovered QA accessory: \(accessory.name)")
    }
    func pairDiscovered() {
        guard let home = testHome(), let accessory = browser.discoveredAccessories.first(where: { isFixtureAccessory($0) }) else {
            record("Discover the QA bridge first"); return
        }
        home.addAccessory(accessory) { error in
            self.record(error.map { "Direct pairing: \($0)" } ?? "Direct pairing complete")
        }
    }
    #if QA_PRIVATE_PAIRING
    // Simulator provisioning only. Never linked into CoreApp.
    func pairWithCode() {
        guard let home = testHome(), let accessory = browser.discoveredAccessories.first(where: { isFixtureAccessory($0) }) else {
            record("Discover the QA bridge first"); return
        }
        let selector = NSSelectorFromString("addAccessory:password:completionHandler:")
        guard home.responds(to: selector) else {
            record("This runtime has no direct pairing entry point")
            var count: UInt32 = 0
            if let methods = class_copyMethodList(HMHome.self, &count) {
                defer { free(methods) }
                for index in 0..<Int(count) {
                    let name = NSStringFromSelector(method_getName(methods[index]))
                    if name.lowercased().contains("pair") || name.contains("addAccessory") { record(name) }
                }
            }
            return
        }
        typealias Call = @convention(c) (AnyObject, Selector, AnyObject, AnyObject, AnyObject) -> Void
        let call = unsafeBitCast(home.method(for: selector), to: Call.self)
        let completion: @convention(block) (NSError?) -> Void = { error in
            self.record(error.map { "Code pairing: \($0)" } ?? "Code pairing complete")
        }
        record("Pairing isolated QA accessory with known fixture PIN")
        call(home, selector, accessory, "482-61-937" as NSString, completion as AnyObject)
    }
    #endif
    func verifyControl() {
        guard let home = testHome() else { return }
        record("Public API: \(home.accessories.count) accessories, \(home.rooms.count) rooms, \(home.actionSets.count) scenes")
        func verify(_ accessoryName: String, _ serviceType: String, _ characteristicType: String, _ value: NSNumber) {
            guard let item = home.accessories.first(where: { $0.name.hasPrefix(accessoryName) }),
                  let service = item.services.first(where: { $0.serviceType == serviceType }),
                  let control = service.characteristics.first(where: { $0.characteristicType == characteristicType }) else {
                record("Missing public control \(accessoryName)/\(characteristicType)"); return
            }
            control.writeValue(value) { error in
                if let error { self.record("Public write failed: \(error)"); return }
                control.readValue { error in
                    if let error { self.record("Public read failed: \(error)"); return }
                    self.record("Public read/write \(accessoryName) \(control.localizedDescription): \(control.value ?? "missing")")
                }
            }
        }
        verify("QA Color Lamp", HMServiceTypeLightbulb, HMCharacteristicTypeBrightness, 37)
        verify("QA Television", HMServiceTypeTelevision, HMCharacteristicTypeTargetMediaState, 1)
        verify("QA Television", HMServiceTypeSpeaker, HMCharacteristicTypeVolume, 35)
        verify("QA Television", HMServiceTypeSpeaker, HMCharacteristicTypeMute, 1)
    }
    func fixtures() {
        guard let home = testHome() else { return }
        guard !home.accessories.isEmpty else { record("Pair the mock bridge first"); return }
        guard home.accessories.allSatisfy({ $0.name.hasPrefix("QA ") }) else {
            record("Unexpected accessory. Only QA fixtures are supported."); return
        }
        if !home.rooms.contains(where: { $0.name == "QA Living Room" }) {
            home.addRoom(withName: "QA Living Room") { room, error in
                if let error { self.record("Room: \(error)"); return }
                self.assign(home, room!)
            }
        } else { assign(home, home.rooms.first(where: { $0.name == "QA Living Room" })!) }
        addScene(home, "QA Evening", accessory: "QA Color Lamp", characteristic: HMCharacteristicTypePowerState, value: 1)
        addScene(home, "QA Unsafe Lock", accessory: "QA Lock", characteristic: HMCharacteristicTypeTargetLockMechanismState, value: 0)
    }
    func addAutomation() {
        guard let home = testHome(), let scene = home.actionSets.first(where: { $0.name == "QA Evening" }) else {
            record("Create the QA Evening scene first"); return
        }
        guard !home.triggers.contains(where: { $0.name == "QA Scheduled Lights" }) else {
            record("QA automation already exists"); return
        }
        let tomorrow = Date().addingTimeInterval(86400)
        let fireDate = Calendar.current.dateInterval(of: .minute, for: tomorrow)!.start
        let trigger = HMTimerTrigger(name: "QA Scheduled Lights", fireDate: fireDate, recurrence: nil)
        home.addTrigger(trigger) { error in
            if let error { self.record("Create automation: \(error)"); return }
            trigger.addActionSet(scene) { error in
                self.record(error.map { "Automation scene: \($0)" } ?? "Created QA Scheduled Lights; enabled=\(trigger.isEnabled), scenes=\(trigger.actionSets.count)")
            }
        }
    }
    func authenticate() {
        let context = LAContext()
        authentication = context
        var error: NSError?
        let biometric = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        record("Biometrics available=\(biometric), type=\(context.biometryType.rawValue), error=\(String(describing: error))")
        error = nil
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            record("Authentication unavailable: \(String(describing: error))"); return
        }
        record("Waiting for device authentication…")
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Test the Apple Home unlock authentication flow") { success, error in
            self.record("Authentication success=\(success), error=\(String(describing: error))")
            context.invalidate()
        }
    }
    private func assign(_ home: HMHome, _ room: HMRoom) {
        for accessory in home.accessories {
            home.assignAccessory(accessory, to: room) { error in
                self.record(error.map { "Assign: \($0)" } ?? "Assigned \(accessory.name)")
            }
        }
    }
    private func addScene(_ home: HMHome, _ name: String, accessory: String, characteristic: String, value: NSNumber) {
        guard !home.actionSets.contains(where: { $0.name == name }) else { return }
        guard let item = home.accessories.first(where: { $0.name == accessory }),
              let control = item.services.flatMap(\.characteristics).first(where: { $0.characteristicType == characteristic }) else {
            record("Missing scene target \(accessory)"); return
        }
        home.addActionSet(withName: name) { scene, error in
            if let error { self.record("Scene: \(error)"); return }
            scene!.addAction(HMCharacteristicWriteAction(characteristic: control, targetValue: value)) { error in
                self.record(error.map { "Scene action: \($0)" } ?? "Created scene \(name)")
            }
        }
    }
}
