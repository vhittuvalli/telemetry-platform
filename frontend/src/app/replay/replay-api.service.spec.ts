import { TestBed } from '@angular/core/testing';

import { ReplayApiService } from './replay-api.service';

describe('ReplayApiService', () => {
  let service: ReplayApiService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ReplayApiService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
