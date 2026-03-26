import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import Layout from "./components/Layout";
import CreateCHD from "./pages/CreateCHD";
import ExtractCHD from "./pages/ExtractCHD";
import ConvertCHD from "./pages/ConvertCHD";
import InfoPage from "./pages/InfoPage";
import VerifyPage from "./pages/VerifyPage";
import Settings from "./pages/Settings";
import "./App.css";

export type Page = "create" | "extract" | "convert" | "info" | "verify" | "settings";

function App() {
  const [page, setPage] = useState<Page>("create");

  useEffect(() => {
    invoke<{ theme: string }>("get_settings")
      .then((s) => {
        document.documentElement.dataset.theme = s.theme || "dark";
      })
      .catch(() => {
        document.documentElement.dataset.theme = "dark";
      });
  }, []);

  return (
    <div className="app">
      <Layout currentPage={page} onNavigate={setPage}>
        <div style={{ display: page === "create"   ? "contents" : "none" }}><CreateCHD /></div>
        <div style={{ display: page === "extract"  ? "contents" : "none" }}><ExtractCHD /></div>
        <div style={{ display: page === "convert"  ? "contents" : "none" }}><ConvertCHD /></div>
        <div style={{ display: page === "info"     ? "contents" : "none" }}><InfoPage /></div>
        <div style={{ display: page === "verify"   ? "contents" : "none" }}><VerifyPage /></div>
        <div style={{ display: page === "settings" ? "contents" : "none" }}><Settings /></div>
      </Layout>
    </div>
  );
}

export default App;
