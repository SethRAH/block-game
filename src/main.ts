import './style.css';
import { blockZoomGestures, mount } from './ui/index.ts';

blockZoomGestures();
const root = document.querySelector<HTMLDivElement>('#app');
if (root) mount(root);
