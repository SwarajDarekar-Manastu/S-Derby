import type { ReleaseShipResult, ReleaseShipStatus } from "@paperclipai/shared";
import { api } from "./client";

export const releaseShipApi = {
  status: (companyId: string) => api.get<ReleaseShipStatus>(`/companies/${companyId}/release-ship`),
  ship: (companyId: string, repo: string) =>
    api.post<ReleaseShipResult>(`/companies/${companyId}/release-ship`, { repo }),
};
