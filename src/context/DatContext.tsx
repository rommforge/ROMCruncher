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
  loading: boolean;
  refreshDats: () => void;
}

const DatContext = createContext<DatContextValue>({
  datIndex: new Map(),
  datInfos: [],
  loading: false,
  refreshDats: () => {},
});

interface DatRom { name: string; sha1: string | null; crc: string | null; is_disk: boolean }
interface DatGame { name: string; description: string; roms: DatRom[] }
interface ParsedDat { header_name: string; header_version: string; games: DatGame[] }

export function DatProvider({ children }: { children: ReactNode }) {
  const [datIndex, setDatIndex] = useState<DatIndex>(new Map());
  const [datInfos, setDatInfos] = useState<DatInfo[]>([]);
  const [loading, setLoading]   = useState(false);

  const refreshDats = useCallback(async () => {
    setLoading(true);
    try {
      const paths = await invoke<string[]>("scan_dat_folder");
      const index: DatIndex = new Map();
      const infos: DatInfo[] = [];

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
        } catch {
          // skip unparseable DAT
        }
      }

      setDatIndex(index);
      setDatInfos(infos);
    } catch {
      // dat folder not available yet
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refreshDats(); }, [refreshDats]);

  return (
    <DatContext.Provider value={{ datIndex, datInfos, loading, refreshDats }}>
      {children}
    </DatContext.Provider>
  );
}

export function useDat() { return useContext(DatContext); }
