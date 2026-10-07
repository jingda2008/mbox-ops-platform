pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral(); maven { url = uri("https://mvn.getui.com/nexus/content/repositories/releases/"); content { includeGroup("com.getui"); includeGroup("com.zxid.sdk") } } } }
rootProject.name = "MBOXStaff"
include(":app")
