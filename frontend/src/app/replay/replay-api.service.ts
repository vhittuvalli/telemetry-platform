import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import {
  BuildJob, CatalogEvent, Dispersion, LapRecord, MotorSummary, ReplayDataWindow, ReplayMeta, ReplaySummary,
  RocketSummary, SimulationRequest,
} from './replay.models';
import { environment } from '../../environments/environment';

const API_URL = environment.apiUrl;
//sets up the API service

@Injectable({ providedIn: 'root' })
export class ReplayApiService {
  private http = inject(HttpClient);

  listReplays(): Observable<ReplaySummary[]> {
    return this.http.get<ReplaySummary[]>(`${API_URL}/replays`);
  }
  getMeta(replayId: string): Observable<ReplayMeta> {
    return this.http.get<ReplayMeta>(`${API_URL}/replays/${replayId}/meta`);
  }
  getData(replayId: string, start: number, end: number): Observable<ReplayDataWindow> {
    return this.http.get<ReplayDataWindow>(`${API_URL}/replays/${replayId}/data`, {
    params: { start, end },
    });
  }
  getDispersion(replayId: string): Observable<Dispersion> {
    return this.http.get<Dispersion>(`${API_URL}/replays/${replayId}/dispersion`);
  }
  getLaps(replayId: string): Observable<LapRecord[]> {
    return this.http.get<LapRecord[]>(`${API_URL}/replays/${replayId}/laps`);
  }

  // FastF1 catalog and replay builds
  getSeasons(): Observable<number[]> {
    return this.http.get<number[]>(`${API_URL}/catalog/seasons`);
  }
  getSeason(year: number): Observable<CatalogEvent[]> {
    return this.http.get<CatalogEvent[]>(`${API_URL}/catalog/${year}`);
  }
  getBuildConfig(): Observable<{ enabled: boolean }> {
    return this.http.get<{ enabled: boolean }>(`${API_URL}/builds/config`);
  }
  startBuild(year: number, round: number, session: string): Observable<BuildJob> {
    return this.http.post<BuildJob>(`${API_URL}/builds`, { year, round, session });
  }
  // Rocket designs and flights simulated on request
  getRockets(): Observable<RocketSummary[]> {
    return this.http.get<RocketSummary[]>(`${API_URL}/rockets`);
  }
  getMotors(): Observable<MotorSummary[]> {
    return this.http.get<MotorSummary[]>(`${API_URL}/rockets/motors`);
  }
  getRocketConfig(): Observable<{ monte_carlo: boolean; max_runs: number }> {
    return this.http.get<{ monte_carlo: boolean; max_runs: number }>(`${API_URL}/rockets/config`);
  }
  simulate(req: SimulationRequest): Observable<{ replay_id: string }> {
    return this.http.post<{ replay_id: string }>(`${API_URL}/rockets/simulate`, req);
  }

  getBuild(buildId: string): Observable<BuildJob> {
    return this.http.get<BuildJob>(`${API_URL}/builds/${buildId}`);
  }
}
