// Subscribing starts the phone ringing, so it waits for the first Select; the subscription ending
// when the app closes stops it. Older apps call the category phone_state.
var FIND_MY_PHONE = "00000000-0000-0000-0001-000000000008";
var subscribed = false;
var ringing = false;

function subscribe(category, fallback) {
    Pebble.subscribeToSource({
        category: category,
        item: "find_my_phone",
        onData: function (envelope) {
            var instance = envelope && envelope.instances && envelope.instances[0];
            var property = instance && instance.properties && instance.properties.ringing;
            ringing = !!(property && property.boolean && property.boolean.value);
            Pebble.sendAppMessage({ RINGING: ringing ? 1 : 0 });
        },
        onError: function (err) {
            if (fallback) {
                subscribe(fallback, null);
                return;
            }
            subscribed = false;
            console.log("find_my_phone subscription failed: " + JSON.stringify(err));
            Pebble.sendAppMessage({ ERROR: err && err.code === "PERMISSION_DENIED"
                ? "Allow Find My Phone in the Pebble app"
                : "Is the Pebble app running?" });
        },
    });
}

Pebble.addEventListener("ready", function () {
    Pebble.sendAppMessage({ RINGING: 0 });
});

Pebble.addEventListener("appmessage", function (e) {
    if (!e.payload || e.payload.RING === undefined) return;
    if (!subscribed) {
        subscribed = true;
        subscribe("phone", "phone_state");
        return;
    }
    Pebble.invokeAction({ plugin: FIND_MY_PHONE, action: ringing ? "stop" : "ring", args: {} });
});
