// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch } from "@/lib/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: Response) {
  vi.stubGlobal("fetch", vi.fn(async () => response));
}

describe("apiFetch", () => {
  it("throws ApiError with the server code, message and details", async () => {
    stubFetch(
      Response.json(
        { error: { code: "project_exists", message: "ABC is already set up", extra: 1 } },
        { status: 409 },
      ),
    );
    const error = await apiFetch("/api/projects", { method: "POST" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "project_exists", message: "ABC is already set up" });
    expect((error as ApiError).details).toEqual({ extra: 1 });
  });

  it("falls back to a generic internal error when the body is not the error shape", async () => {
    stubFetch(new Response("<html>boom</html>", { status: 500 }));
    const error = await apiFetch("/api/projects").catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 500, code: "internal", message: "Something went wrong" });
  });

  it("returns the parsed JSON body on success", async () => {
    stubFetch(Response.json({ projects: [] }));
    await expect(apiFetch<{ projects: unknown[] }>("/api/projects")).resolves.toEqual({ projects: [] });
  });

  it("sends a JSON body with a content type and leaves FormData alone", async () => {
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () =>
      Response.json({ ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await apiFetch("/api/projects", { method: "POST", body: JSON.stringify({ a: 1 }) });
    const jsonInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(jsonInit.headers).get("Content-Type")).toBe("application/json");

    const form = new FormData();
    form.set("kind", "guideline");
    await apiFetch("/api/projects/x/files", { method: "POST", body: form });
    const formInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect(new Headers(formInit.headers).get("Content-Type")).toBeNull();
  });
});

describe("sign-in redirect", () => {
  function stubLocation() {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    return assign;
  }

  it.each(["unauthorized", "reauth_required"])("sends a %s response to the sign-in route", async (code) => {
    const assign = stubLocation();
    stubFetch(Response.json({ error: { code, message: "Sign in again" } }, { status: 401 }));
    await expect(apiFetch("/api/projects")).rejects.toMatchObject({ code });
    expect(assign).toHaveBeenCalledWith("/api/auth/login");
  });

  it.each([
    ["forbidden", 403],
    ["not_found", 404],
    ["internal", 500],
  ])("does not redirect for a %s response", async (code, status) => {
    const assign = stubLocation();
    stubFetch(Response.json({ error: { code, message: "Nope" } }, { status }));
    await expect(apiFetch("/api/projects")).rejects.toMatchObject({ code });
    expect(assign).not.toHaveBeenCalled();
  });
});
