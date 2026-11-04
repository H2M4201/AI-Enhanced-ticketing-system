import type { ParsedDocument } from "@/core/domain";
import type { DraftOutput } from "@/core/pipeline/draft";

/** The "requirements.md" sections of the Checkout Revamp sample, with the refs the draft cites. */
export const sampleDocuments: ParsedDocument[] = [
  {
    filename: "requirements.md",
    kind: "md",
    sections: [
      { ref: "requirements.md §2", heading: "Guest checkout", text: "Guests can check out without creating an account." },
      { ref: "requirements.md §2.1", heading: "Saving a card for later", text: "Guests can save a card for later." },
      { ref: "requirements.md §2.2", heading: "Confirmation email", text: "Guests receive an order confirmation email." },
      { ref: "requirements.md §3.2", heading: "Saving a card", text: "Only logged-in users can save cards." },
      { ref: "requirements.md §4.1", heading: "Totals", text: "Shipping is shown as a fixed amount per order." },
    ],
  },
];

/** A well-formed model reply for the Checkout Revamp sample. Later tasks reuse it. */
export const sampleDraftOutput: DraftOutput = {
  epic: {
    title: "Checkout Revamp",
    description: "One-page checkout for guests and logged-in shoppers, replacing the three-page checkout.",
  },
  stories: [
    {
      tempId: "s1",
      title: "Checkout: one-page guest checkout",
      description: "As a guest, I want to check out on one page, so that I can pay in fewer steps.",
      acceptanceCriteria: [
        "The guest shopper can enter an email address, a shipping address and a payment method on one checkout page.",
      ],
      estimate: 5,
      sourceRefs: ["requirements.md §2"],
      origin: "from_docs",
      assumptionQuestionIds: [],
      shapedBy: ["guidelines.md"],
      tasks: [
        {
          title: "Checkout: render the one-page guest form",
          description: "Build the one-page checkout form for guests.",
          sourceRefs: ["requirements.md §2"],
          origin: "from_docs",
          assumptionQuestionIds: [],
          shapedBy: ["guidelines.md"],
        },
        {
          title: "QA: test one-page guest checkout",
          description: "Covers the acceptance criteria of the guest checkout story.",
          sourceRefs: [],
          origin: "ai_suggestion",
          assumptionQuestionIds: [],
          shapedBy: ["guidelines.md"],
        },
      ],
    },
    {
      tempId: "s2",
      title: "Checkout: save a card",
      description: "As a logged-in shopper, I want to save a card, so that my next purchase is faster.",
      acceptanceCriteria: [
        "The account holder sees a Save this card checkbox on the checkout page only when signed in.",
      ],
      estimate: 3,
      sourceRefs: ["requirements.md §2.1", "requirements.md §3.2"],
      origin: "from_docs",
      assumptionQuestionIds: ["Q1"],
      shapedBy: ["guidelines.md"],
      tasks: [
        {
          title: "Checkout: hide the save-card checkbox for guests",
          description: "Hide the checkbox for guest shoppers.",
          sourceRefs: ["requirements.md §3.2"],
          origin: "from_docs",
          assumptionQuestionIds: [],
          shapedBy: ["guidelines.md"],
        },
        {
          title: "QA: test save a card",
          description: "Covers the acceptance criteria of the save-card story.",
          sourceRefs: [],
          origin: "ai_suggestion",
          assumptionQuestionIds: [],
          shapedBy: ["guidelines.md"],
        },
      ],
    },
    {
      tempId: "s3",
      title: "Checkout: order confirmation email",
      description: "As a guest, I want an order confirmation email, so that I can track my order.",
      acceptanceCriteria: [
        "The guest shopper receives a confirmation email with the order number once the order is placed.",
      ],
      estimate: 2,
      sourceRefs: ["requirements.md §2.2"],
      origin: "from_docs",
      assumptionQuestionIds: [],
      shapedBy: ["guidelines.md"],
      tasks: [
        {
          title: "Checkout: send the confirmation email when the order is placed",
          description: "Send the email once the order is placed.",
          sourceRefs: ["requirements.md §2.2"],
          origin: "from_docs",
          assumptionQuestionIds: [],
          shapedBy: ["guidelines.md"],
        },
        {
          title: "QA: test order confirmation email",
          description: "Covers the acceptance criteria of the confirmation email story.",
          sourceRefs: [],
          origin: "ai_suggestion",
          assumptionQuestionIds: [],
          shapedBy: ["guidelines.md"],
        },
      ],
    },
    {
      tempId: "s4",
      title: "Payment timeout handling",
      description: "As a shopper, I want a clear message when payment times out, so that I know whether I was charged.",
      acceptanceCriteria: [
        "The shopper sees a message on the payment step when the payment provider does not respond in time.",
      ],
      estimate: 3,
      sourceRefs: [],
      origin: "ai_suggestion",
      assumptionQuestionIds: [],
      shapedBy: [],
      tasks: [
        {
          title: "Checkout: show a timeout message on the payment step",
          description: "Show the message when the payment request times out.",
          sourceRefs: [],
          origin: "ai_suggestion",
          assumptionQuestionIds: [],
          shapedBy: [],
        },
      ],
    },
  ],
};
