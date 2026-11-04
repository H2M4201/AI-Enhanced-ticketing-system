// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderBadge } from "@/components/ProviderBadge";

afterEach(cleanup);

describe("ProviderBadge", () => {
  it("marks cloud hosts", () => {
    render(
      <ProviderBadge
        provider={{ source: "profile", name: "OpenAI", model: "gpt-x", baseUrlHost: "api.openai.com" }}
      />,
    );
    expect(screen.getByText(/cloud/i)).toBeInTheDocument();
    expect(screen.getByText("OpenAI · gpt-x (api.openai.com)")).toBeInTheDocument();
  });

  it("explains the cloud marker in its title", () => {
    render(
      <ProviderBadge
        provider={{ source: "profile", name: "OpenAI", model: "gpt-x", baseUrlHost: "api.openai.com" }}
      />,
    );
    expect(screen.getByTitle(/external service/i)).toHaveTextContent("cloud");
  });

  it("does not mark localhost", () => {
    render(
      <ProviderBadge
        provider={{ source: "profile", name: "Ollama", model: "llama3", baseUrlHost: "localhost:11434" }}
      />,
    );
    expect(screen.queryByText(/cloud/i)).not.toBeInTheDocument();
  });

  it("does not mark 127.0.0.1 or [::1]", () => {
    const { unmount } = render(
      <ProviderBadge provider={{ source: "env", name: "Local", model: "m", baseUrlHost: "127.0.0.1:1234" }} />,
    );
    expect(screen.queryByText(/cloud/i)).not.toBeInTheDocument();
    unmount();
    render(<ProviderBadge provider={{ source: "env", name: "Local", model: "m", baseUrlHost: "[::1]:8080" }} />);
    expect(screen.queryByText(/cloud/i)).not.toBeInTheDocument();
  });
});
