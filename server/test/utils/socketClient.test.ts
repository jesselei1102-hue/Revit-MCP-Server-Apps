import { describe, it, expect } from "vitest";
import { RevitClientConnection } from "../../src/utils/SocketClient";

describe("RevitClientConnection", () => {
  it("decodes UTF-8 characters split across socket chunks", () => {
    const client = new RevitClientConnection("localhost", 1);
    let received = "";
    client.responseCallbacks.set("x", (data) => (received = data));
    const bytes = Buffer.from(JSON.stringify({ id: "x", result: "防火等级 Fire Rating" }), "utf8");
    const cut = bytes.indexOf(Buffer.from("火", "utf8")) + 1; // inside the 3-byte character
    client.socket.emit("data", bytes.subarray(0, cut));
    client.socket.emit("data", bytes.subarray(cut));
    expect(JSON.parse(received).result).toBe("防火等级 Fire Rating");
    client.socket.destroy();
  });
});
