import assert from "node:assert/strict";
import {
	backendOrigin,
	validateInstallInput,
	validateServerCredentials,
} from "./install-validation";

assert.deepEqual(
	validateServerCredentials({
		host: " 203.0.113.10 ",
		port: 22,
		password: "temporary",
	}),
	{ host: "203.0.113.10", port: 22, password: "temporary" },
);
assert.equal(backendOrigin("2001:db8::1"), "http://[2001:db8::1]:3000");
assert.equal(
	validateInstallInput({
		host: "server.example.com",
		port: 2222,
		password: "temporary",
		expectedFingerprint: `SHA256:${"a".repeat(64)}`,
		image: "ghcr.io/example/dokploy-backend:v1",
	}).image,
	"ghcr.io/example/dokploy-backend:v1",
);
assert.throws(() =>
	validateInstallInput({
		host: "server.example.com; reboot",
		port: 22,
		password: "temporary",
		expectedFingerprint: "unverified",
		image: "image; reboot",
	}),
);

console.log("install validation: ok");
