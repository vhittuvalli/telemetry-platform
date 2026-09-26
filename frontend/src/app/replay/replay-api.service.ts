import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { ReplayDataWindow, ReplayMeta } from './replay.models';

const API_URL = 'http://localhost:8000';
//sets up the API service

@Injectable({ providedIn: 'root' })
export class ReplayApiService {
  private http = inject(HttpClient);

  getMeta(replayId: string): Observable<ReplayMeta> {
    return this.http.get<ReplayMeta>(`${API_URL}/replays/${replayId}/meta`);
  }
  getData(replayId: string, start: number, end: number): Observable<ReplayDataWindow> {
  return this.http.get<ReplayDataWindow>(`${API_URL}/replays/${replayId}/data`, {
    params: { start, end },
  });
}
}