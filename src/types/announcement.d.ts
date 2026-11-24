enum AppPlatformEnum {
    ANDROID = 'ANDROID',
    IOS = 'IOS',
    WEB = 'WEB'
}

enum UserKindEnum {
    STUDENT = 'STUDENT',
    EMPLOYEE = 'EMPLOYEE',
    GUEST = 'GUEST'
}

export interface Announcement {
    id: number
    platform: AppPlatformEnum[]
    userKind: UserKindEnum[]
    title: {
        de: string
        en: string
    }
    description: {
        de: string
        en: string
    }
    startDateTime: Date | string
    endDateTime: Date | string
    priority: number
    url: string | null
    imageUrl: string | null
    createdAt: Date
    updatedAt: Date
}
