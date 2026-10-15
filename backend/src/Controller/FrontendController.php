<?php

namespace App\Controller;

use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpFoundation\BinaryFileResponse;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

/**
 * Serves the built web viewer when it has been copied into public/ (see
 * DEPLOYMENT.md): everything else in that folder is a real file that the web
 * server returns directly, but "/" is a directory request, and both Apache's
 * DirectoryIndex and PHP's built-in server prefer public/index.php — which is
 * Symfony, which would answer 404. This route closes that gap, so the same
 * layout works from `php -S -t public` on a laptop and behind a real server.
 */
final class FrontendController
{
    #[Route('/', name: 'app_home', methods: ['GET'])]
    public function home(
        #[Autowire('%kernel.project_dir%/public/index.html')]
        string $indexPath,
    ): Response {
        if (!is_file($indexPath)) {
            return new Response(
                "NASA Viz — API only.\nThe web build isn't deployed here; see DEPLOYMENT.md, or run the Vite dev server.\nRoutes: /api/iss/position, /api/neo, /api/neo/positions, /api/neo/details, /api/apod, /api/usage\n",
                Response::HTTP_OK,
                ['Content-Type' => 'text/plain; charset=utf-8'],
            );
        }

        // Read and send it rather than BinaryFileResponse, which needs
        // symfony/mime to guess the type — not worth a dependency for one
        // small HTML file whose type we know. The page is a cache-busted shell
        // (its assets carry hashed names), so it must not be cached itself.
        return new Response(file_get_contents($indexPath), Response::HTTP_OK, [
            'Content-Type' => 'text/html; charset=utf-8',
            'Cache-Control' => 'no-cache, private',
        ]);
    }
}
