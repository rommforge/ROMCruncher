import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { basename } from "../utils/path";

export interface DatMatch {
  gameName: string;
  romName: string;
  datFile: string;
}

export interface DatInfo {
  filePath: string;
  fileName: string;
  headerName: string;
  headerVersion: string;
  entryCount: number;
}

// Keys are lowercase SHA1 or CRC32 hex strings.
export type DatIndex = Map<string, DatMatch>;

interface DatContextValue {
  datIndex: DatIndex;
  datInfos: DatInfo[];
  parseErrors: string[];
  loading: boolean;
  refreshDats: () => void;
  datExtraPaths: string[];
  addDatPath: (path: string) => Promise<void>;
  removeDatPath: (path: string) => Promise<void>;
}

const DatContext = createContext<DatContextValue>({
  datIndex: new Map(),
  datInfos: [],
  parseErrors: [],
  loading: false,
  refreshDats: () => {},
  datExtraPaths: [],
  addDatPath: async () => {},
  removeDatPath: async () => {},
});

interface DatRom { name: string; sha1: string | null; crc: string | null; is_disk: boolean }
interface DatGame { name: string; description: string; roms: DatRom[] }
interface ParsedDat { header_name: string; header_version: string; games: DatGame[] }
interface Settings { chdman_path: string; theme: string; dat_extra_paths: string[] }

export function DatProvider({ children }: { children: ReactNode }) {
  const [datIndex, setDatIndex]         = useState<DatIndex>(new Map());
  const [datInfos, setDatInfos]         = useState<DatInfo[]>([]);
  const [parseErrors, setParseErrors]   = useState<string[]>([]);
  const [loading, setLoading]           = useState(false);
  const [datExtraPaths, setDatExtraPaths] = useState<string[]>([]);

  const refreshDats = useCallback(async () => {
    setLoading(true);
    try {
      const paths = await invoke<string[]>("scan_dat_folder");
      const index: DatIndex = new Map();
      const infos: DatInfo[] = [];
      const errors: string[] = [];

      for (const p of paths) {
        try {
          const parsed = await invoke<ParsedDat>("parse_dat", { path: p });
          const fileName = basename(p);
          let count = 0;
          for (const game of parsed.games) {
            for (const rom of game.roms) {
              const match: DatMatch = {
                gameName: game.description || game.name,
                romName:  rom.name,
                datFile:  fileName,
              };
              if (rom.sha1) { index.set(rom.sha1.toLowerCase(), match); count++; }
              if (rom.crc)  { index.set(rom.crc.toLowerCase(),  match); }
            }
          }
          infos.push({
            filePath:      p,
            fileName,
            headerName:    parsed.header_name || fileName,
            headerVersion: parsed.header_version,
            entryCount:    count,
          });
        } catch (e) {
          errors.push(`${basename(p)}: ${String(e)}`);
        }
      }

      setDatIndex(index);
      setDatInfos(infos);
      setParseErrors(errors);
    } catch {
      // dat folder not available yet
    } finally {
      setLoading(false);
    }
  }, []);

  // Load extra paths from settings on mount
  useEffect(() => {
    invoke<Settings>("get_settings")
      .then((s) => setDatExtraPaths(s.dat_extra_paths ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => { refreshDats(); }, [refreshDats]);

  const addDatPath = useCallback(async (path: string) => {
    setDatExtraPaths((prev) => {
      if (prev.includes(path)) return prev;
      const next = [...prev, path];
      invoke("save_dat_paths", { paths: next }).catch(() => {});
      return next;
    });
    // Refresh after state settles
    setTimeout(refreshDats, 50);
  }, [refreshDats]);

  const removeDatPath = useCallback(async (path: string) => {
    setDatExtraPaths((prev) => {
      const next = prev.filter((p) => p !== path);
      invoke("save_dat_paths", { paths: next }).catch(() => {});
      return next;
    });
    setTimeout(refreshDats, 50);
  }, [refreshDats]);

  return (
    <DatContext.Provider value={{ datIndex, datInfos, parseErrors, loading, refreshDats, datExtraPaths, addDatPath, removeDatPath }}>
      {children}
    </DatContext.Provider>
  );
}

export function useDat() { return useContext(DatContext); }
