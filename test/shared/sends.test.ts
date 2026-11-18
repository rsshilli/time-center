import type { TodoSent } from "../../src/shared/ipc";
import { uniqueSends, withSend } from "../../src/shared/sends";

const cowork = (at: number): TodoSent => ({ action: "cowork", label: "Claude Cowork", url: "claude://cowork", at });
const qbdcode = (label: string, at: number): TodoSent => ({ action: "qbdcode", label, url: null, at });

describe("withSend", () => {
  it("should keep one entry per place, the latest, when the same item is sent there again", () => {
    const sent = withSend(withSend([cowork(1)], qbdcode("QbDCode · qbdvision2", 2)), cowork(3));
    expect(sent).toEqual([qbdcode("QbDCode · qbdvision2", 2), cowork(3)]);
  });

  it("should keep sends to different worktrees apart", () => {
    expect(withSend([qbdcode("QbDCode · qbdvision2", 1)], qbdcode("QbDCode · qbdvision3", 2))).toHaveLength(2);
  });
});

describe("uniqueSends", () => {
  it("should show a list saved with repeats (two Cowork sends) as one entry per place", () => {
    expect(uniqueSends([cowork(1), cowork(2)])).toEqual([cowork(2)]);
  });
});
