// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { Provider, createStore } from "jotai";
import { stubRadixGlobals } from "@/test-utils/radix";
import { assistantAvatarDataUrlAtom } from "@/stores/ui";
import { AssistantProfileCard } from "./assistant-profile-card";

stubRadixGlobals();
beforeEach(() => cleanup());

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="path">{location.pathname}</output>;
}

describe("AssistantProfileCard", () => {
  it("navigates via 发消息 / 更换头像", () => {
    render(
      <Provider>
        <MemoryRouter initialEntries={["/chat"]}>
          <AssistantProfileCard trigger={<button type="button">头像</button>} name="Claude Code" model="fake-model" />
          <LocationProbe />
        </MemoryRouter>
      </Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "头像" }));
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.getByLabelText("Claude Code 头像").textContent).toBe("C");
    fireEvent.click(screen.getByRole("button", { name: /发消息/ }));
    expect(screen.getByTestId("path").textContent).toBe("/");
    fireEvent.click(screen.getByRole("button", { name: /更换头像/ }));
    expect(screen.getByTestId("path").textContent).toBe("/common");
  });

  it("opens and closes the avatar zoom overlay for a custom avatar", () => {
    const store = createStore();
    store.set(assistantAvatarDataUrlAtom, "data:image/png;base64,AAAA");
    render(
      <Provider store={store}>
        <MemoryRouter>
          <AssistantProfileCard trigger={<button type="button">头像</button>} />
        </MemoryRouter>
      </Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "头像" }));
    fireEvent.click(screen.getByRole("button", { name: "放大查看头像" }));
    expect(screen.getByAltText(/头像大图/)).toBeTruthy();
    fireEvent.click(screen.getByRole("presentation"));
    expect(screen.queryByAltText(/头像大图/)).toBeNull();
  });
});
