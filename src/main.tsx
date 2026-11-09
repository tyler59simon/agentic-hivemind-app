import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";
import { QuickCapture } from "./features/capture/QuickCapture";

const client = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 30_000 } },
});

// One bundle, two windows: the quick-capture window is opened at #capture.
const isCapture = window.location.hash === "#capture";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      {isCapture ? <QuickCapture /> : <App />}
    </QueryClientProvider>
  </React.StrictMode>,
);
