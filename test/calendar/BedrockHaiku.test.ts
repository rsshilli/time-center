import { parseShellKeys } from "../../src/main/calendar/BedrockHaiku";

describe("parseShellKeys", () => {
  it("should read the keys line past the shell's start-up noise", () => {
    const output = "bash: no job control in this shell\n\x1b[?2004l\n__TIME_CENTER_AWS__AKIA1\x1fsecret1\x1f\x1fus-west-2\n";
    expect(parseShellKeys(output)).toEqual({ accessKeyId: "AKIA1", secretAccessKey: "secret1", sessionToken: null, region: "us-west-2" });
  });

  it("should give null when the shell sets no keys, or only half of them", () => {
    expect(parseShellKeys("")).toBeNull();
    expect(parseShellKeys("__TIME_CENTER_AWS__\x1f\x1f\x1f\n")).toBeNull();
    expect(parseShellKeys("__TIME_CENTER_AWS__AKIA1\x1f\x1f\x1fus-east-1\n")).toBeNull();
  });
});
