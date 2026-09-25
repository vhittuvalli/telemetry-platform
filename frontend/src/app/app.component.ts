import { Component } from '@angular/core';
import { ReplayViewerComponent } from './replay-viewer/replay-viewer.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [ReplayViewerComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent {}