<?php

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    throw new RuntimeException('Execute este arquivo somente pelo terminal.');
}

require '/var/www/glpi/vendor/autoload.php';

$kernel = new Glpi\Kernel\Kernel();
$kernel->boot();

foreach (['ADMIN_PASSWORD', 'TECH_PASSWORD', 'USER_PASSWORD', 'API_PASSWORD', 'API_TOKEN', 'APP_TOKEN'] as $key) {
    if (strlen(getenv('THEO_' . $key) ?: '') < 16) {
        throw new RuntimeException('Credencial ausente ou muito curta: THEO_' . $key);
    }
}

Session::callAsSystem(function (): void {
    Config::setConfigurationValues('core', [
        'language' => 'pt_BR',
        'url_base' => 'http://127.0.0.1:8088',
        'enable_api' => 1,
        'enable_api_login_credentials' => 1,
        'enable_api_login_external_token' => 1,
    ]);

    $admin = new User();
    if (!$admin->getFromDBbyName('glpi')) {
        throw new RuntimeException('Administrador local não encontrado.');
    }
    $adminData = ['id' => $admin->getID(), 'language' => 'pt_BR'];
    if (!password_verify(getenv('THEO_ADMIN_PASSWORD'), $admin->fields['password'])) {
        $adminData['password'] = $adminData['password2'] = getenv('THEO_ADMIN_PASSWORD');
    }
    if (!$admin->update($adminData)) {
        throw new RuntimeException('Não foi possível configurar o administrador local.');
    }

    foreach (['normal', 'tech', 'post-only'] as $name) {
        $user = new User();
        if ($user->getFromDBbyName($name) && !$user->update(['id' => $user->getID(), 'is_active' => 0])) {
            throw new RuntimeException('Não foi possível desativar a conta padrão: ' . $name);
        }
    }

    // shortcut: a integração usa Technician no demo; restringir as permissões antes de usar dados reais.
    $users = [
        'tecnico.demo' => ['Technician', 'TECH_PASSWORD', 'Técnico de demonstração'],
        'usuario.demo' => ['Self-Service', 'USER_PASSWORD', 'Usuário de demonstração'],
        'theo.api' => ['Technician', 'API_PASSWORD', 'Theo — integração local'],
    ];

    foreach ($users as $name => [$profileName, $passwordKey, $displayName]) {
        $profile = new Profile();
        if (!$profile->getFromDBByCrit(['name' => $profileName])) {
            throw new RuntimeException('Perfil padrão não encontrado: ' . $profileName);
        }
        $user = new User();
        $exists = $user->getFromDBbyName($name);
        $password = getenv('THEO_' . $passwordKey);
        $data = [
            'name' => $name,
            'realname' => $displayName,
            'language' => 'pt_BR',
            'is_active' => 1,
            '_profiles_id' => $profile->getID(),
            '_entities_id' => 0,
        ];
        if (!$exists || !password_verify($password, $user->fields['password'])) {
            $data['password'] = $data['password2'] = $password;
        }
        if ($name === 'theo.api') {
            $data['api_token'] = getenv('THEO_API_TOKEN');
        }
        $saved = $exists ? $user->update(['id' => $user->getID()] + $data) : $user->add($data);
        if (!$saved || !$user->getFromDBbyName($name) || !password_verify($password, $user->fields['password'])) {
            throw new RuntimeException('Falha ao configurar a conta: ' . $name);
        }
        $rights = new Profile_User();
        $assignment = ['users_id' => $user->getID(), 'profiles_id' => $profile->getID(), 'entities_id' => 0];
        if (!$rights->getFromDBByCrit($assignment) && !$rights->add($assignment)) {
            throw new RuntimeException('Falha ao atribuir o perfil de: ' . $name);
        }
        if (!$user->update(['id' => $user->getID(), 'profiles_id' => $profile->getID(), 'entities_id' => 0])) {
            throw new RuntimeException('Falha ao definir o perfil padrão de: ' . $name);
        }
        echo $name . ' configurado com perfil ' . $profileName . PHP_EOL;
    }

    $catalogPath = '/tmp/theo-categories.json';
    $categories = json_decode(file_get_contents($catalogPath), true, 512, JSON_THROW_ON_ERROR);
    foreach ($categories as &$entry) {
        $category = new ITILCategory();
        $exists = $category->getFromDBByCrit(['name' => $entry['name'], 'entities_id' => 0]);
        $data = [
            'name' => $entry['name'], 'entities_id' => 0, 'comment' => $entry['description'],
            'is_helpdeskvisible' => 1, 'is_incident' => 1, 'is_request' => 1,
        ];
        $saved = $exists ? $category->update(['id' => $category->getID()] + $data) : $category->add($data);
        if (!$saved) throw new RuntimeException('Falha ao configurar a categoria ' . $entry['name']);
        $entry['id'] = $category->getID();
        echo 'Categoria ' . $entry['name'] . ': ' . $entry['id'] . PHP_EOL;
    }
    unset($entry);
    if (file_put_contents('/tmp/theo-categories-resolved.json', json_encode($categories, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR) . PHP_EOL) === false) {
        throw new RuntimeException('Não foi possível exportar os IDs das categorias.');
    }

    $client = new APIClient();
    $clientData = ['name' => 'Theo local', 'is_active' => 1, 'app_token' => getenv('THEO_APP_TOKEN')];
    $clientSaved = $client->getFromDBByCrit(['name' => 'Theo local'])
        ? $client->update(['id' => $client->getID()] + $clientData)
        : $client->add($clientData);
    if (!$clientSaved) {
        throw new RuntimeException('Falha ao configurar o cliente da API.');
    }
    echo 'API habilitada; contas padrão extras desativadas; senha do administrador alterada.' . PHP_EOL;
});
