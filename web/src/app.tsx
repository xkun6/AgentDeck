import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { DEFAULT_THEME_CONFIG, hydrateThemeAtom, usePlatform, type ThemeConfig } from "@agentdeck/shared-ui";
import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { useSetAtom } from "jotai";
import { useSidecarBridge } from "@/hooks/use-agent-session";
import { readUiValue } from "@/lib/ui-store";
import { ErrorBoundary } from "@/components/error-boundary";
import { AppShell } from "@/components/app-shell/app-shell";
import { CommandPalette } from "@/components/command-palette";

// ---------------------------------------------------------------------------
// Route-level code splitting.
//
// Every route is loaded with React.lazy() so each page ships as its own chunk
// and is fetched + parsed only when the user actually navigates to it. The app
// shell (sidebar/topbar/statusbar) stays eager: it is the chrome that must
// render immediately.
// ---------------------------------------------------------------------------
const PanelRoute = lazy(() => import("@/routes/panel").then((m) => ({ default: m.PanelRoute })));
const DetailRoute = lazy(() => import("@/routes/detail").then((m) => ({ default: m.DetailRoute })));
const HistoryRoute = lazy(() => import("@/routes/history").then((m) => ({ default: m.HistoryRoute })));
const ProjectsRoute = lazy(() => import("@/routes/projects").then((m) => ({ default: m.ProjectsRoute })));
const ProjectDetailRoute = lazy(() => import("@/routes/project-detail").then((m) => ({ default: m.ProjectDetailRoute })));
const ConsoleRoute = lazy(() => import("@/routes/console").then((m) => ({ default: m.ConsoleRoute })));
const ThemeRoute = lazy(() => import("@/routes/advanced").then((m) => ({ default: m.ThemeRoute })));
const AdvancedRoute = lazy(() => import("@/routes/advanced").then((m) => ({ default: m.AdvancedRoute })));
const CodingAgentsRoute = lazy(() => import("@/routes/coding-agents").then((m) => ({ default: m.CodingAgentsRoute })));
const AgentProvidersRoute = lazy(() => import("@/routes/agent-providers").then((m) => ({ default: m.AgentProvidersRoute })));

function NewTaskRedirect() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: "/", search }} replace />;
}

// Wrap each route's content in a local ErrorBoundary so a single page crash
// keeps AppShell (sidebar + nav) usable instead of blanking the whole app via
// the root boundary. Each route element mounts its own boundary, which resets
// naturally on navigation. (#37)
function withBoundary(node: ReactNode) {
  return <ErrorBoundary>{node}</ErrorBoundary>;
}

// Minimal Suspense fallback while a lazy route chunk loads. Kept dependency-
// free on purpose: it must render even before the route chunk has been fetched.
function RouteLoadingFallback() {
  return <div className="route-loading" data-route-loading="true" />;
}

function MainApp() {
  useSidecarBridge();
  return (
    <>
      <AppShell>
        <Suspense fallback={<RouteLoadingFallback />}>
          <Routes>
            <Route path="/" element={withBoundary(<PanelRoute />)} />
            <Route path="/new" element={<NewTaskRedirect />} />
            <Route path="/tasks/:taskId" element={withBoundary(<DetailRoute />)} />
            <Route path="/history" element={withBoundary(<HistoryRoute />)} />
            <Route path="/projects" element={withBoundary(<ProjectsRoute />)} />
            <Route path="/projects/:workspacePath" element={withBoundary(<ProjectDetailRoute />)} />
            <Route path="/console" element={withBoundary(<ConsoleRoute />)} />
            <Route path="/theme" element={withBoundary(<ThemeRoute />)} />
            <Route path="/common" element={withBoundary(<AdvancedRoute />)} />
            <Route path="/notifications" element={withBoundary(<AdvancedRoute />)} />
            <Route path="/env" element={withBoundary(<AdvancedRoute />)} />
            <Route path="/agent-providers" element={withBoundary(<AgentProvidersRoute />)} />
            <Route path="/coding-agents" element={withBoundary(<CodingAgentsRoute />)} />
            <Route path="/about" element={withBoundary(<AdvancedRoute />)} />
            <Route path="/advanced/*" element={withBoundary(<AdvancedRoute />)} />
            <Route path="/settings" element={<Navigate to="/common" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </AppShell>
      <CommandPalette />
    </>
  );
}

export function App() {
  const platform = usePlatform();
  const hydrateTheme = useSetAtom(hydrateThemeAtom);
  useEffect(() => {
    hydrateTheme(readUiValue<Partial<ThemeConfig>>("hermes-theme", DEFAULT_THEME_CONFIG));
  }, [hydrateTheme]);

  return <div lang="zh-CN" data-hermes-platform={platform}><MainApp /></div>;
}
