function validateOrg(id:string): boolean {
    // Simple validation: org ID should be non-empty and alphanumeric
    const orgIdPattern = /^[a-zA-Z0-9_-]+$/;
    return orgIdPattern.test(id)&& id.length >3;
}