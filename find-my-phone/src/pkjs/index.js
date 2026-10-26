var FIND_MY_PHONE = "00000000-0000-0000-0001-000000000008";

Pebble.addEventListener("ready", function () {
    Pebble.invokeAction({ plugin: FIND_MY_PHONE, action: "ring", args: {} }).then(function (result) {
        Pebble.sendAppMessage(result.ok
            ? { RESULT: 1 }
            : { RESULT: 0, MESSAGE: result.code === "PERMISSION_DENIED"
                ? "Allow Find My Phone in the Pebble app"
                : "Couldn't ring your phone" });
    }, function (err) {
        Pebble.sendAppMessage({ RESULT: 0, MESSAGE: "Couldn't ring your phone" });
        console.log("find my phone ring failed: " + JSON.stringify(err));
    });
});
