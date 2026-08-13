import { redactForLogging } from "./Log2File";

describe("Log2File.redactForLogging", () => {
  it("redacts callbackToken fields recursively without mutating the source", () => {
    const source = {
      id: 1,
      callbackToken: "secret",
      nested: [{ callbackToken: "other", amount: 42 }],
    };

    expect(redactForLogging(source)).toEqual({
      id: 1,
      callbackToken: "[REDACTED]",
      nested: [{ callbackToken: "[REDACTED]", amount: 42 }],
    });
    expect(source.callbackToken).toBe("secret");
  });

  it("redacts token query values in callback URLs and preserves other parameters", () => {
    expect(redactForLogging({
      confirmedCallbackURL: "http://payjoin:8000/receive/address/x?token=secret&mode=confirmed",
      unconfirmedCallbackURL: "http://payjoin:8000/receive/address/x?mode=zero&token=secret",
    })).toEqual({
      confirmedCallbackURL: "http://payjoin:8000/receive/address/x?token=[REDACTED]&mode=confirmed",
      unconfirmedCallbackURL: "http://payjoin:8000/receive/address/x?mode=zero&token=[REDACTED]",
    });
  });

  it("redacts bearer-token log strings and token-like credential fields", () => {
    expect(redactForLogging("generated token=header.payload.signature")).toBe(
      "generated token=[REDACTED]",
    );
    expect(redactForLogging({ token: "secret", authorization: "Bearer secret" })).toEqual({
      token: "[REDACTED]",
      authorization: "[REDACTED]",
    });
  });
});
