"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { api } from "@/lib/api";
import type { Me, MeGroup, Member } from "@/lib/types";

interface SessionValue {
  me: Me | null;
  loading: boolean;
  activeGroup: MeGroup | null;
  members: Member[];
  membersLoading: boolean;
  refresh: () => Promise<void>;
  refreshMembers: () => Promise<void>;
  switchGroup: (groupId: number) => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [members, setMembers] = useState<Member[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);

  const refresh = useCallback(async () => {
    const data = await api.get<Me>("/api/auth/me");
    setMe(data);
  }, []);

  const refreshMembers = useCallback(async () => {
    setMembersLoading(true);
    try {
      const data = await api.get<{ members: Member[] }>("/api/groups/active/members");
      setMembers(data.members);
    } catch {
      setMembers([]);
    } finally {
      setMembersLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await refresh();
      } catch {
        // 401 already redirects to /auth/login inside the api wrapper
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh]);

  const activeGroup: MeGroup | null = me
    ? me.user.groups.find((g) => g.id === me.activeGroupId) ?? me.user.groups[0] ?? null
    : null;

  const activeGroupId = activeGroup?.id ?? null;
  useEffect(() => {
    if (activeGroupId != null) {
      refreshMembers();
    } else {
      setMembers([]);
    }
  }, [activeGroupId, refreshMembers]);

  const switchGroup = useCallback(
    async (groupId: number) => {
      await api.post("/api/groups/active", { groupId });
      await refresh();
    },
    [refresh]
  );

  return (
    <SessionContext.Provider
      value={{
        me,
        loading,
        activeGroup,
        members,
        membersLoading,
        refresh,
        refreshMembers,
        switchGroup,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession deve ser usado dentro de <SessionProvider>");
  return value;
}
