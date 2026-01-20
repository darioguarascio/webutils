import { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { readdirSync, statSync } from 'fs';

const handler = async function(req: Request, res: Response) {
  const routes: Array<{ method: string; path: string }> = [];
  
  // Extract routes from file system (since express-file-routing is file-based)
  const routesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../routes/");
  
  function scanRoutes(dir: string, basePath: string = '') {
    try {
      const files = readdirSync(dir);
      
      for (const file of files) {
        // Skip index.ts to avoid self-reference
        if (file === 'index.ts' || file === 'index.js') {
          continue;
        }
        
        const filePath = path.join(dir, file);
        const stat = statSync(filePath);
        
        if (stat.isDirectory()) {
          // Handle directories (like proxy/)
          let routePath = basePath + '/' + file;
          scanRoutes(filePath, routePath);
        } else if (file.endsWith('.ts') || file.endsWith('.js')) {
          // Handle route files
          let routePath = basePath;
          
          // Handle catch-all routes [...url]
          if (file.startsWith('[...') && file.includes('].')) {
            const paramName = file.match(/\[\.\.\.(\w+)\]/)?.[1] || 'param';
            routePath = basePath + '/[...' + paramName + ']';
          }
          // Handle dynamic routes [id]
          else if (file.startsWith('[') && file.includes('].')) {
            const paramName = file.match(/\[(\w+)\]/)?.[1] || 'id';
            routePath = basePath + '/[' + paramName + ']';
          }
          // Handle regular routes
          else {
            const routeName = file.replace(/\.(ts|js)$/, '');
            routePath = basePath + '/' + routeName;
          }
          
          // Determine HTTP methods from the file
          // Default to GET if no specific export, or check for exported methods
          // For now, assume all routes support GET (can be enhanced)
          routes.push({
            method: 'GET',
            path: routePath || '/'
          });
        }
      }
    } catch (err) {
      // Ignore errors
    }
  }
  
  scanRoutes(routesDir);
  
  // Add the index route itself
  routes.push({
    method: 'GET',
    path: '/'
  });
  
  // Also try to extract from Express router stack as fallback
  const app = req.app;
  
  function extractFromRouter(layer: any, basePath: string = '') {
    if (layer.route) {
      const route = layer.route;
      const path = basePath + (route.path === '/' ? '' : route.path);
      if (route.stack && Array.isArray(route.stack)) {
        route.stack.forEach((stackItem: any) => {
          if (stackItem && stackItem.methods) {
            const methods = Object.keys(stackItem.methods).filter(m => m !== '_all');
            methods.forEach((method: string) => {
              routes.push({
                method: method.toUpperCase(),
                path: path || '/'
              });
            });
          }
        });
      }
    } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      let mountPath = basePath;
      if (layer.regexp) {
        const regexSource = layer.regexp.source;
        // Try to extract mount path from regex
        const match = regexSource.match(/^\\\/(.*?)(?:\\\/|$)/);
        if (match && match[1] && match[1] !== '\\?') {
          mountPath = basePath + '/' + match[1].replace(/\\\//g, '/').replace(/\\\./g, '.');
        }
      }
      
      layer.handle.stack.forEach((nestedLayer: any) => {
        extractFromRouter(nestedLayer, mountPath);
      });
    }
  }
  
  if (app._router && app._router.stack) {
    app._router.stack.forEach((layer: any) => {
      extractFromRouter(layer);
    });
  }
  
  // Remove duplicates and sort routes by path, then by method
  const uniqueRoutes = Array.from(
    new Map(routes.map(r => [`${r.method}:${r.path}`, r])).values()
  );
  
  uniqueRoutes.sort((a, b) => {
    if (a.path !== b.path) {
      return a.path.localeCompare(b.path);
    }
    return a.method.localeCompare(b.method);
  });
  
  res.json({
    routes: uniqueRoutes,
    count: uniqueRoutes.length
  });
};

export const get = [
  handler
];

