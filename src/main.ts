import './style.css';
import { mount } from './ui/index.ts';

const root = document.querySelector<HTMLDivElement>('#app');
if (root) mount(root);
