// One press rings the phone; another press while it is still ringing (it stops by itself after a
// minute) stops it.
var FIND_MY_PHONE = "00000000-0000-0000-0001-000000000008";
var RANG_AT_KEY = "rangAt";
var RING_MS = 60 * 1000;

Pebble.addEventListener("ready", function () {
    var rangAt = Number(localStorage.getItem(RANG_AT_KEY)) || 0;
    var stopping = Date.now() - rangAt < RING_MS;
    Pebble.invokeAction({ plugin: FIND_MY_PHONE, action: stopping ? "stop" : "ring", args: {} }).then(function (result) {
        if (!result.ok) {
            Pebble.sendAppMessage({ RESULT: 0, MESSAGE: result.code === "PERMISSION_DENIED"
                ? "Allow Find My Phone in the Pebble app"
                : "Couldn't ring your phone" });
            return;
        }
        localStorage.setItem(RANG_AT_KEY, stopping ? "0" : String(Date.now()));
        Pebble.sendAppMessage({ RESULT: 1, RINGING: stopping ? 0 : 1 });
    }, function (err) {
        console.log("find my phone failed: " + JSON.stringify(err));
        Pebble.sendAppMessage({ RESULT: 0, MESSAGE: "Couldn't ring your phone" });
    });
});
