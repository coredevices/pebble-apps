// Subscribing is the on/off switch: the phone rings while this app is subscribed, and the
// subscription ending when the app closes stops it. Older apps call the category phone_state.
var FIND_MY_PHONE = "00000000-0000-0000-0001-000000000008";

function subscribe(category, fallback) {
    Pebble.subscribeToSource({
        category: category,
        item: "find_my_phone",
        onData: function (envelope) {
            var instance = envelope && envelope.instances && envelope.instances[0];
            var ringing = instance && instance.properties && instance.properties.ringing;
            Pebble.sendAppMessage({ RINGING: ringing && ringing.boolean && ringing.boolean.value ? 1 : 0 });
        },
        onError: function (err) {
            if (fallback) {
                subscribe(fallback, null);
                return;
            }
            console.log("find_my_phone subscription failed: " + JSON.stringify(err));
            Pebble.sendAppMessage({ ERROR: err && err.code === "PERMISSION_DENIED"
                ? "Allow Find My Phone in the Pebble app"
                : "Is the Pebble app running?" });
        },
    });
}

Pebble.addEventListener("ready", function () {
    subscribe("phone", "phone_state");
});

Pebble.addEventListener("appmessage", function (e) {
    if (e.payload && e.payload.RING !== undefined) {
        Pebble.invokeAction({ plugin: FIND_MY_PHONE, action: "ring", args: {} });
    }
});
