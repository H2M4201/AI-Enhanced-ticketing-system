import type { ChatMessage, LlmClient } from "@/core/llm/client";

/** Scripted LlmClient for tests. Replies are returned in order; running out throws. */
export class FakeLlm implements LlmClient {
  readonly model = "fake";
  readonly calls: ChatMessage[][] = [];
  private next = 0;

  constructor(private readonly replies: (string | ((msgs: ChatMessage[]) => string))[]) {}

  async complete(messages: ChatMessage[]): Promise<string> {
    this.calls.push([...messages]);
    if (this.next >= this.replies.length) throw new Error("FakeLlm: no more scripted replies");
    const reply = this.replies[this.next++];
    return typeof reply === "function" ? reply(messages) : reply;
  }
}
